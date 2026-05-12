import { describe, it, expect, vi } from 'vitest';
import {
  parseExecuteCodeBlocks,
  extractFirstPythonFence,
  buildSchemaExtractionCode,
  formatCellOutputForDraft,
  buildDataAnalysisDraftPrompt,
  createCodeExecutor,
  type CodeExecutionRecord,
  type DataFileForSandbox,
} from '../services/codeExecutor';
import type { Sandbox, CodeExecutionOutput } from '../services/sandbox';

function makeSandbox(
  outputs: CodeExecutionOutput[] | ((code: string) => CodeExecutionOutput),
): { sandbox: Sandbox; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    sandbox: {
      containerName: 'test',
      isRunning: true,
      async start() {},
      async stop() {},
      async execute(code) {
        calls.push(code);
        if (typeof outputs === 'function') return outputs(code);
        const out = outputs[i] ?? outputs[outputs.length - 1];
        i += 1;
        return out;
      },
    },
  };
}

function ok(stdout = ''): CodeExecutionOutput {
  return { stdout, stderr: '', images: [], timedOut: false };
}

function reviewSafe() {
  return Promise.resolve({ safe: true });
}

describe('parseExecuteCodeBlocks', () => {
  it('parses a single EXECUTE_CODE block', () => {
    const text = 'Some text.\n\nEXECUTE_CODE:\n```python\nprint(1)\n```\n\nMore.';
    const blocks = parseExecuteCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe('print(1)');
  });

  it('parses multiple blocks in order', () => {
    const text =
      'A\nEXECUTE_CODE:\n```python\nx=1\n```\nB\nEXECUTE_CODE:\n```python\ny=2\n```\nC';
    const blocks = parseExecuteCodeBlocks(text);
    expect(blocks.map((b) => b.code)).toEqual(['x=1', 'y=2']);
    expect(blocks[0].start).toBeLessThan(blocks[1].start);
  });

  it('ignores python fences not preceded by EXECUTE_CODE', () => {
    const text = 'Some prose\n```python\nprint(1)\n```\n';
    const blocks = parseExecuteCodeBlocks(text);
    expect(blocks).toHaveLength(0);
  });

  it('returns empty array on text with no blocks', () => {
    expect(parseExecuteCodeBlocks('no code here')).toEqual([]);
  });
});

describe('extractFirstPythonFence', () => {
  it('returns the first python fence body', () => {
    expect(extractFirstPythonFence('```python\nprint(1)\n```')).toBe('print(1)');
  });
  it('returns null when no fence', () => {
    expect(extractFirstPythonFence('plain text')).toBeNull();
  });
});

describe('buildSchemaExtractionCode', () => {
  it('uses read_csv for csv files and read_excel for xlsx', () => {
    const files: DataFileForSandbox[] = [
      { storagePath: '/h/a.csv', containerName: 'a.csv', extension: 'csv', originalName: 'a.csv' },
      { storagePath: '/h/b.xlsx', containerName: 'b.xlsx', extension: 'xlsx', originalName: 'b.xlsx' },
    ];
    const code = buildSchemaExtractionCode(files, 100_000);
    expect(code).toContain('import pandas as pd');
    expect(code).toContain('ROW_CAP = 100000');
    expect(code).toContain('pd.read_csv("/sandbox/data/a.csv", nrows=ROW_CAP)');
    expect(code).toContain('pd.read_excel("/sandbox/data/b.xlsx", nrows=ROW_CAP)');
    expect(code).toContain('df_0.head(5)');
    expect(code).toContain('df_1.head(5)');
  });
});

describe('formatCellOutputForDraft', () => {
  const base: CodeExecutionRecord = {
    cellIndex: 2,
    phase: 'draft',
    code: 'print(1)',
    stdout: 'hello',
    stderr: '',
    images: [],
    timedOut: false,
    durationMs: 10,
    retries: 0,
    reviewSafe: true,
  };
  it('formats stdout-only output', () => {
    const s = formatCellOutputForDraft(base);
    expect(s).toContain('[Code cell 2]');
    expect(s).toContain('hello');
  });
  it('includes error marker on error', () => {
    const s = formatCellOutputForDraft({
      ...base,
      stdout: '',
      error: 'kaboom',
      errorType: 'ValueError',
    });
    expect(s).toContain('ERROR: ValueError');
    expect(s).toContain('Error: kaboom');
  });
  it('embeds base64 images as markdown', () => {
    const s = formatCellOutputForDraft({ ...base, images: ['AAA', 'BBB'] });
    expect(s).toContain('data:image/png;base64,AAA');
    expect(s).toContain('data:image/png;base64,BBB');
  });
});

describe('buildDataAnalysisDraftPrompt', () => {
  it('returns base prompt when no schema preview', () => {
    const p = buildDataAnalysisDraftPrompt({
      basePrompt: 'BASE',
      schemaPreview: null,
      filenames: ['a.csv'],
    });
    expect(p).toBe('BASE');
  });
  it('injects schema + EXECUTE_CODE instructions when sandbox active', () => {
    const p = buildDataAnalysisDraftPrompt({
      basePrompt: 'BASE',
      schemaPreview: 'rows: 100',
      filenames: ['a.csv'],
    });
    expect(p).toContain('BASE');
    expect(p).toContain('EXECUTE_CODE:');
    expect(p).toContain('a.csv');
    expect(p).toContain('rows: 100');
  });
});

describe('createCodeExecutor', () => {
  it('runs schema extraction as cell 1', async () => {
    const { sandbox, calls } = makeSandbox([ok('schema-out')]);
    const exec = createCodeExecutor({ sandbox, reviewCodeFn: reviewSafe });
    const rec = await exec.runSchemaExtraction([
      { storagePath: '/h/a.csv', containerName: 'a.csv', extension: 'csv', originalName: 'a.csv' },
    ]);
    expect(rec).toBeTruthy();
    expect(rec!.cellIndex).toBe(1);
    expect(rec!.phase).toBe('schema');
    expect(rec!.stdout).toBe('schema-out');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('pd.read_csv');
  });

  it('processDraft replaces EXECUTE_CODE blocks with output text', async () => {
    const { sandbox } = makeSandbox([ok('result=42')]);
    const exec = createCodeExecutor({ sandbox, reviewCodeFn: reviewSafe });
    const text = 'Intro.\nEXECUTE_CODE:\n```python\nprint(42)\n```\nOutro.';
    const result = await exec.processDraft(text, 'draft');
    expect(result.records).toHaveLength(1);
    expect(result.draft).toContain('Intro.');
    expect(result.draft).toContain('Outro.');
    expect(result.draft).toContain('result=42');
    expect(result.draft).not.toContain('EXECUTE_CODE');
  });

  it('returns draft unchanged when no EXECUTE_CODE blocks', async () => {
    const { sandbox, calls } = makeSandbox([ok()]);
    const exec = createCodeExecutor({ sandbox, reviewCodeFn: reviewSafe });
    const result = await exec.processDraft('plain text', 'draft');
    expect(result.draft).toBe('plain text');
    expect(result.records).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('regenerates code when review rejects, up to retry limit', async () => {
    const { sandbox } = makeSandbox([ok('ok')]);
    const reviewFn = vi
      .fn()
      .mockResolvedValueOnce({ safe: false, reason: 'subprocess' })
      .mockResolvedValue({ safe: true });
    const generateFn = vi.fn().mockResolvedValue('```python\nfixed = 1\n```');
    const exec = createCodeExecutor({
      sandbox,
      reviewCodeFn: reviewFn,
      generateFn: generateFn as never,
    });
    const result = await exec.processDraft(
      'EXECUTE_CODE:\n```python\nimport subprocess\n```\n',
      'draft',
    );
    expect(reviewFn).toHaveBeenCalledTimes(2);
    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(result.records[0].reviewSafe).toBe(true);
    expect(result.records[0].code).toBe('fixed = 1');
  });

  it('gives up on a review-reject after retry budget and records CodeReviewError', async () => {
    const { sandbox } = makeSandbox([ok()]);
    const reviewFn = vi.fn().mockResolvedValue({ safe: false, reason: 'nope' });
    const generateFn = vi.fn().mockResolvedValue('```python\nstill bad\n```');
    const exec = createCodeExecutor({
      sandbox,
      reviewCodeFn: reviewFn,
      generateFn: generateFn as never,
      cellRetries: 2,
    });
    const result = await exec.processDraft(
      'EXECUTE_CODE:\n```python\nbad()\n```\n',
      'draft',
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0].reviewSafe).toBe(false);
    expect(result.records[0].errorType).toBe('CodeReviewError');
  });

  it('retries on execution failure with regenerated code', async () => {
    let i = 0;
    const { sandbox } = makeSandbox(() => {
      i += 1;
      if (i === 1) return { stdout: '', stderr: '', images: [], timedOut: false, error: 'NameError: x', errorType: 'NameError' };
      return ok('done');
    });
    const generateFn = vi.fn().mockResolvedValue('```python\nx = 1\nprint("done")\n```');
    const exec = createCodeExecutor({
      sandbox,
      reviewCodeFn: reviewSafe,
      generateFn: generateFn as never,
    });
    const result = await exec.processDraft(
      'EXECUTE_CODE:\n```python\nprint(x)\n```',
      'draft',
    );
    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].error).toBeUndefined();
    expect(result.records[0].stdout).toBe('done');
  });

  it('enforces cell budget — skips additional cells once budget exhausted', async () => {
    const { sandbox, calls } = makeSandbox(() => ok('x'));
    const exec = createCodeExecutor({
      sandbox,
      reviewCodeFn: reviewSafe,
      cellBudget: 2,
    });
    const draft =
      'EXECUTE_CODE:\n```python\na=1\n```\n' +
      'EXECUTE_CODE:\n```python\nb=2\n```\n' +
      'EXECUTE_CODE:\n```python\nc=3\n```';
    const result = await exec.processDraft(draft, 'draft');
    expect(calls).toHaveLength(2);
    expect(result.records).toHaveLength(2);
    expect(result.draft).toContain('budget exhausted');
    expect(exec.cellsUsed).toBe(2);
  });

  it('marks sandbox dead when execute() throws and stops further cells', async () => {
    const { sandbox } = makeSandbox(() => {
      throw new Error('sandbox is no longer running');
    });
    const exec = createCodeExecutor({ sandbox, reviewCodeFn: reviewSafe });
    const draft =
      'EXECUTE_CODE:\n```python\na=1\n```\n' +
      'EXECUTE_CODE:\n```python\nb=2\n```';
    const result = await exec.processDraft(draft, 'draft');
    expect(result.records[0].errorType).toBe('SandboxError');
    expect(exec.isDead).toBe(true);
    // second block should be skipped (no record for it)
    expect(result.records).toHaveLength(1);
  });

  it('emits onProgress with cellsUsed/cellBudget after each cell', async () => {
    const { sandbox } = makeSandbox([ok('a'), ok('b')]);
    const progress = vi.fn();
    const exec = createCodeExecutor({
      sandbox,
      reviewCodeFn: reviewSafe,
      cellBudget: 5,
      onProgress: progress,
    });
    await exec.processDraft(
      'EXECUTE_CODE:\n```python\na\n```\nEXECUTE_CODE:\n```python\nb\n```',
      'draft',
    );
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls[0][0]).toMatchObject({ cellsUsed: 1, cellBudget: 5, phase: 'draft' });
    expect(progress.mock.calls[1][0]).toMatchObject({ cellsUsed: 2, cellBudget: 5 });
  });

  it('attaches code-execution span to traceParent when present', async () => {
    const { sandbox } = makeSandbox([ok('x')]);
    const spanEnd = vi.fn();
    const child = {
      update: vi.fn(),
      end: spanEnd,
      startGeneration: vi.fn(),
      startSpan: vi.fn(),
    };
    const traceParent = {
      update: vi.fn(),
      end: vi.fn(),
      startGeneration: vi.fn(),
      startSpan: vi.fn().mockReturnValue(child),
    };
    const exec = createCodeExecutor({
      sandbox,
      reviewCodeFn: reviewSafe,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceParent: traceParent as any,
    });
    await exec.runSchemaExtraction([
      { storagePath: '/h/a.csv', containerName: 'a.csv', extension: 'csv', originalName: 'a.csv' },
    ]);
    expect(traceParent.startSpan).toHaveBeenCalledWith(
      'code-execution',
      expect.objectContaining({ metadata: expect.objectContaining({ phase: 'schema' }) }),
    );
    expect(spanEnd).toHaveBeenCalled();
  });
});
