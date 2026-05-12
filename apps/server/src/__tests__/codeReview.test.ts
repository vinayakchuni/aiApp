import { describe, it, expect, vi } from 'vitest';
import {
  IMPORT_WHITELIST,
  CODE_REVIEW_SYSTEM_PROMPT,
  buildCodeReviewMessages,
  parseCodeReview,
  reviewCode,
} from '../services/codeReview';

describe('IMPORT_WHITELIST', () => {
  it('lists every module the PRD calls out', () => {
    const expected = [
      'pandas', 'numpy', 'openpyxl', 'csv', 'json', 're', 'math', 'datetime',
      'collections', 'itertools', 'functools', 'matplotlib', 'seaborn',
      'sklearn', 'statsmodels', 'scipy', 'os.path', 'io', 'warnings', 'typing',
    ];
    for (const mod of expected) {
      expect(IMPORT_WHITELIST).toContain(mod);
    }
  });
});

describe('CODE_REVIEW_SYSTEM_PROMPT', () => {
  it('names every whitelisted module so the LLM sees the canonical list', () => {
    for (const mod of IMPORT_WHITELIST) {
      expect(CODE_REVIEW_SYSTEM_PROMPT).toContain(mod);
    }
  });

  it('asks for the SAFE / UNSAFE single-line response shape', () => {
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/SAFE/);
    expect(CODE_REVIEW_SYSTEM_PROMPT).toMatch(/UNSAFE/);
  });
});

describe('buildCodeReviewMessages', () => {
  it('produces a system + user pair with the code in a fenced python block', () => {
    const msgs = buildCodeReviewMessages('print("hi")');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toBe(CODE_REVIEW_SYSTEM_PROMPT);
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('```python');
    expect(msgs[1].content).toContain('print("hi")');
  });
});

describe('parseCodeReview', () => {
  it('treats a bare SAFE line as safe', () => {
    expect(parseCodeReview('SAFE')).toEqual({ safe: true });
  });

  it('is case insensitive on the verdict', () => {
    expect(parseCodeReview('safe')).toEqual({ safe: true });
  });

  it('reads the reason from an UNSAFE: <reason> line', () => {
    const result = parseCodeReview('UNSAFE: imports subprocess');
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('imports subprocess');
  });

  it('reads only the first line when the LLM adds prose', () => {
    const result = parseCodeReview('UNSAFE: uses eval on a dynamic string\nadditional context');
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('uses eval on a dynamic string');
  });

  it('falls back to a sentinel reason when UNSAFE is given without explanation', () => {
    const result = parseCodeReview('UNSAFE');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/no reason/i);
  });

  it('fails closed on empty input', () => {
    const result = parseCodeReview('   ');
    expect(result.safe).toBe(false);
  });

  it('fails closed on an unparseable verdict', () => {
    const result = parseCodeReview('maybe this is fine?');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/unparseable/);
  });

  it('does not accept "unsafe" prefixed text as SAFE', () => {
    const result = parseCodeReview('UNSAFE: nope');
    expect(result.safe).toBe(false);
  });
});

describe('reviewCode', () => {
  it('returns safe=true on a SAFE verdict from the LLM', async () => {
    const generateFn = vi.fn().mockResolvedValue('SAFE');
    const result = await reviewCode('import pandas as pd\ndf = pd.read_csv("/sandbox/data/a.csv")', {
      generateFn: generateFn as never,
    });
    expect(result).toEqual({ safe: true });
    expect(generateFn).toHaveBeenCalledTimes(1);
  });

  it('returns safe=false with reason on UNSAFE verdict', async () => {
    const generateFn = vi.fn().mockResolvedValue('UNSAFE: imports subprocess');
    const result = await reviewCode('import subprocess\nsubprocess.run(["ls"])', {
      generateFn: generateFn as never,
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('imports subprocess');
  });

  it('passes the supplied modelId and generation name through to the LLM call', async () => {
    const generateFn = vi.fn().mockResolvedValue('SAFE');
    await reviewCode('print(1)', {
      modelId: 'anthropic:claude-haiku',
      generateFn: generateFn as never,
    });
    const [, modelId, opts] = generateFn.mock.calls[0];
    expect(modelId).toBe('anthropic:claude-haiku');
    expect(opts).toMatchObject({ generationName: 'code-review' });
  });

  it('forwards the traceParent so the call appears under the active span', async () => {
    const generateFn = vi.fn().mockResolvedValue('SAFE');
    const fakeTrace = { tag: 'fake' } as never;
    await reviewCode('print(1)', { generateFn: generateFn as never, traceParent: fakeTrace });
    const [, , opts] = generateFn.mock.calls[0];
    expect(opts.trace).toBe(fakeTrace);
  });

  it('fails closed when the LLM throws', async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error('network blip'));
    const result = await reviewCode('print(1)', { generateFn: generateFn as never });
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/network blip/);
  });

  it('fails closed on empty code without calling the LLM', async () => {
    const generateFn = vi.fn();
    const result = await reviewCode('   \n  ', { generateFn: generateFn as never });
    expect(result.safe).toBe(false);
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('rethrows when an abort signal is set and the LLM rejects', async () => {
    const ac = new AbortController();
    ac.abort();
    const generateFn = vi.fn().mockRejectedValue(new Error('aborted'));
    await expect(
      reviewCode('print(1)', { generateFn: generateFn as never, abortSignal: ac.signal }),
    ).rejects.toThrow('aborted');
  });
});
