import type { CodeExecutionOutput, Sandbox } from './sandbox';
import type { PhaseSpan } from './tracing';
import { reviewCode, type ReviewCodeOptions, type CodeReviewResult } from './codeReview';
import { generateAssistantText } from './ai';
import type { LLMMessage } from './context';
import { DEFAULT_MODEL_ID } from './models';

export const DEFAULT_CELL_BUDGET = 15;
export const DEFAULT_CELL_RETRIES = 3;
export const SCHEMA_ROW_CAP = 100_000;

export type DataFileExtension = 'csv' | 'xlsx';

export interface DataFileForSandbox {
  storagePath: string;
  containerName: string;
  extension: DataFileExtension;
  originalName: string;
}

export type CodeExecutionPhase = 'schema' | 'draft' | 'revise';

export interface CodeExecutionRecord {
  cellIndex: number;
  phase: CodeExecutionPhase;
  code: string;
  stdout: string;
  stderr: string;
  images: string[];
  timedOut: boolean;
  error?: string;
  errorType?: string;
  durationMs: number;
  retries: number;
  reviewSafe: boolean;
  reviewReason?: string;
}

export interface CodeBlockMatch {
  code: string;
  start: number;
  end: number;
  raw: string;
}

const EXECUTE_BLOCK_RE =
  /EXECUTE_CODE\s*:?\s*\r?\n```(?:python|py)?\s*\r?\n([\s\S]*?)```/gi;
const FALLBACK_PYTHON_FENCE_RE = /```(?:python|py)?\s*\r?\n([\s\S]*?)```/i;

export function parseExecuteCodeBlocks(text: string): CodeBlockMatch[] {
  const out: CodeBlockMatch[] = [];
  EXECUTE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXECUTE_BLOCK_RE.exec(text)) !== null) {
    out.push({
      code: m[1].trim(),
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    });
  }
  return out;
}

export function extractFirstPythonFence(text: string): string | null {
  const m = text.match(FALLBACK_PYTHON_FENCE_RE);
  return m ? m[1].trim() : null;
}

export function buildSchemaExtractionCode(
  files: readonly DataFileForSandbox[],
  rowCap: number = SCHEMA_ROW_CAP,
): string {
  const lines: string[] = [
    'import pandas as pd',
    `ROW_CAP = ${rowCap}`,
  ];
  files.forEach((f, idx) => {
    const varName = `df_${idx}`;
    const filePath = `/sandbox/data/${f.containerName}`;
    if (f.extension === 'csv') {
      lines.push(
        `${varName} = pd.read_csv(${JSON.stringify(filePath)}, nrows=ROW_CAP)`,
      );
    } else {
      lines.push(
        `${varName} = pd.read_excel(${JSON.stringify(filePath)}, nrows=ROW_CAP)`,
      );
    }
    lines.push(
      `print(${JSON.stringify(`=== ${f.originalName} (variable: ${varName}) ===`)})`,
    );
    lines.push(`print('rows:', len(${varName}))`);
    lines.push(`print('columns:', list(${varName}.columns))`);
    lines.push(`print('dtypes:')`);
    lines.push(`print(${varName}.dtypes.to_string())`);
    lines.push(`print('head:')`);
    lines.push(`print(${varName}.head(5).to_string())`);
    lines.push(`print()`);
  });
  return lines.join('\n');
}

export function formatCellOutputForDraft(record: CodeExecutionRecord): string {
  const header =
    `[Code cell ${record.cellIndex}` +
    (record.timedOut
      ? ' — TIMED OUT'
      : record.error
        ? ` — ERROR: ${record.errorType ?? 'Error'}`
        : '') +
    ']';
  const parts: string[] = [header];
  const stdout = record.stdout.trim();
  if (stdout.length > 0) parts.push(stdout);
  if (record.error) parts.push(`Error: ${record.error}`);
  record.images.forEach((img, i) => {
    parts.push(`![chart-${record.cellIndex}-${i}](data:image/png;base64,${img})`);
  });
  if (stdout.length === 0 && !record.error && record.images.length === 0) {
    parts.push('(no output)');
  }
  return parts.join('\n');
}

export interface BuildDataAnalysisPromptOptions {
  basePrompt: string;
  schemaPreview: string | null;
  filenames: string[];
}

export function buildDataAnalysisDraftPrompt(
  opts: BuildDataAnalysisPromptOptions,
): string {
  if (!opts.schemaPreview) return opts.basePrompt;
  const fileList = opts.filenames.map((n) => `- ${n}`).join('\n');
  return `${opts.basePrompt}

PYTHON ANALYSIS TOOL: You have access to a sandboxed Python interpreter. Uploaded data files are pre-loaded:
${fileList}

To run Python code, emit a block in this exact format:

EXECUTE_CODE:
\`\`\`python
# your code here
\`\`\`

State persists between cells, so DataFrames loaded earlier remain available. The first cell already ran and produced the schema preview below. Use code execution for statistics, aggregations, charts, or modeling that supports your claims. Reference results from cell outputs in your prose.

PREDICTIVE / STATISTICAL MODELING: When the user's question benefits from it, use sklearn or statsmodels appropriately:
- Trend / forecasting on a numeric outcome: sklearn.linear_model.LinearRegression, or statsmodels.api.OLS for coefficient p-values; statsmodels.tsa.seasonal.seasonal_decompose for time-series with a date column.
- Predicting a category: sklearn.linear_model.LogisticRegression or sklearn.ensemble.RandomForestClassifier; report accuracy + a confusion matrix.
- Clustering / segmentation: sklearn.cluster.KMeans with a brief justification of k.
- Correlations: df.corr() plus a seaborn heatmap.
Always explain your modeling choice in one sentence in the prose, name the metric you used, and quote the actual numeric result from the cell output. Do not claim predictive accuracy you did not measure.

SCHEMA PREVIEW (cell 1 output):
${opts.schemaPreview}`;
}

export interface CodeExecutorDeps {
  sandbox: Sandbox;
  modelId?: string;
  cellBudget?: number;
  cellRetries?: number;
  abortSignal?: AbortSignal;
  traceParent?: PhaseSpan;
  reviewCodeFn?: (code: string, opts?: ReviewCodeOptions) => Promise<CodeReviewResult>;
  generateFn?: typeof generateAssistantText;
  onProgress?: (info: { cellsUsed: number; cellBudget: number; phase: CodeExecutionPhase }) => void;
}

export interface CodeExecutor {
  readonly records: CodeExecutionRecord[];
  readonly cellsUsed: number;
  readonly cellBudget: number;
  readonly remaining: number;
  readonly isDead: boolean;
  runSchemaExtraction(files: readonly DataFileForSandbox[]): Promise<CodeExecutionRecord | null>;
  processDraft(draft: string, phase: 'draft' | 'revise'): Promise<{ draft: string; records: CodeExecutionRecord[] }>;
}

export function createCodeExecutor(deps: CodeExecutorDeps): CodeExecutor {
  const cellBudget = deps.cellBudget ?? DEFAULT_CELL_BUDGET;
  const cellRetries = deps.cellRetries ?? DEFAULT_CELL_RETRIES;
  const modelId = deps.modelId ?? DEFAULT_MODEL_ID;
  const reviewCodeFn = deps.reviewCodeFn ?? reviewCode;
  const generateFn = deps.generateFn ?? generateAssistantText;
  const records: CodeExecutionRecord[] = [];
  let cellsUsed = 0;
  let dead = false;

  async function regenerateCode(
    prevCode: string,
    feedback: string,
  ): Promise<string | null> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are revising a single Python code cell that just failed. Output ONLY one corrected Python code block fenced with ```python``` and nothing else.',
      },
      {
        role: 'user',
        content: `Previous code:\n\`\`\`python\n${prevCode}\n\`\`\`\n\nFeedback: ${feedback}\n\nProduce the corrected code now.`,
      },
    ];
    try {
      const text = await generateFn(messages, modelId, {
        trace: deps.traceParent,
        generationName: 'code-regenerate',
      });
      return extractFirstPythonFence(text);
    } catch (err) {
      if (deps.abortSignal?.aborted) return null;
      console.error('code-regenerate LLM failed:', err);
      return null;
    }
  }

  async function executeOne(
    initialCode: string,
    phase: CodeExecutionPhase,
  ): Promise<CodeExecutionRecord | null> {
    if (dead) return null;
    if (cellsUsed >= cellBudget) return null;
    if (deps.abortSignal?.aborted) return null;

    let currentCode = initialCode;
    let reviewAttempt = 0;
    let execAttempt = 0;
    let lastReviewReason: string | undefined;

    while (true) {
      if (deps.abortSignal?.aborted) return null;
      const cellSpan = deps.traceParent?.startSpan('code-execution', {
        metadata: { phase, cellsUsed, reviewAttempt, execAttempt },
      });

      const review = await reviewCodeFn(currentCode, {
        modelId,
        traceParent: cellSpan,
        abortSignal: deps.abortSignal,
      });
      if (!review.safe) {
        lastReviewReason = review.reason;
        cellSpan?.end({
          level: 'WARNING',
          statusMessage: 'code review failed',
          metadata: { reason: review.reason, reviewAttempt },
        });
        reviewAttempt += 1;
        if (reviewAttempt > cellRetries) {
          cellsUsed += 1;
          const rec: CodeExecutionRecord = {
            cellIndex: cellsUsed,
            phase,
            code: currentCode,
            stdout: '',
            stderr: '',
            images: [],
            timedOut: false,
            error: `code review failed after ${cellRetries} retries: ${
              review.reason ?? 'unknown'
            }`,
            errorType: 'CodeReviewError',
            durationMs: 0,
            retries: reviewAttempt - 1,
            reviewSafe: false,
            reviewReason: review.reason,
          };
          records.push(rec);
          deps.onProgress?.({ cellsUsed, cellBudget, phase });
          return rec;
        }
        const regen = await regenerateCode(
          currentCode,
          `Code review rejected the cell: ${review.reason ?? 'unspecified'}`,
        );
        if (!regen) {
          cellsUsed += 1;
          const rec: CodeExecutionRecord = {
            cellIndex: cellsUsed,
            phase,
            code: currentCode,
            stdout: '',
            stderr: '',
            images: [],
            timedOut: false,
            error: `code review rejected and regeneration failed: ${
              review.reason ?? 'unknown'
            }`,
            errorType: 'CodeReviewError',
            durationMs: 0,
            retries: reviewAttempt,
            reviewSafe: false,
            reviewReason: review.reason,
          };
          records.push(rec);
          deps.onProgress?.({ cellsUsed, cellBudget, phase });
          return rec;
        }
        currentCode = regen;
        continue;
      }

      cellsUsed += 1;
      const t0 = Date.now();
      let out: CodeExecutionOutput;
      try {
        out = await deps.sandbox.execute(currentCode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dead = true;
        const rec: CodeExecutionRecord = {
          cellIndex: cellsUsed,
          phase,
          code: currentCode,
          stdout: '',
          stderr: '',
          images: [],
          timedOut: false,
          error: message,
          errorType: 'SandboxError',
          durationMs: Date.now() - t0,
          retries: reviewAttempt + execAttempt,
          reviewSafe: true,
          reviewReason: lastReviewReason,
        };
        cellSpan?.end({
          level: 'ERROR',
          statusMessage: 'sandbox error',
          metadata: { error: message },
        });
        records.push(rec);
        deps.onProgress?.({ cellsUsed, cellBudget, phase });
        return rec;
      }
      const durationMs = Date.now() - t0;
      const rec: CodeExecutionRecord = {
        cellIndex: cellsUsed,
        phase,
        code: currentCode,
        stdout: out.stdout,
        stderr: out.stderr,
        images: out.images,
        timedOut: out.timedOut,
        error: out.error,
        errorType: out.errorType,
        durationMs,
        retries: reviewAttempt + execAttempt,
        reviewSafe: true,
        reviewReason: lastReviewReason,
      };
      cellSpan?.end({
        metadata: {
          phase,
          durationMs,
          timedOut: out.timedOut,
          errorType: out.errorType,
          imageCount: out.images.length,
          stdoutBytes: out.stdout.length,
        },
        output: {
          stdout: out.stdout,
          stderr: out.stderr,
          error: out.error,
          imageCount: out.images.length,
        },
      });

      if (out.error || out.timedOut) {
        execAttempt += 1;
        if (execAttempt > cellRetries || cellsUsed >= cellBudget) {
          records.push(rec);
          deps.onProgress?.({ cellsUsed, cellBudget, phase });
          return rec;
        }
        const feedback = out.timedOut
          ? 'Previous attempt exceeded the cell timeout.'
          : `Previous attempt failed: ${out.errorType ?? 'Error'}: ${out.error ?? 'unknown error'}`;
        const regen = await regenerateCode(currentCode, feedback);
        if (!regen) {
          records.push(rec);
          deps.onProgress?.({ cellsUsed, cellBudget, phase });
          return rec;
        }
        currentCode = regen;
        continue;
      }

      records.push(rec);
      deps.onProgress?.({ cellsUsed, cellBudget, phase });
      return rec;
    }
  }

  return {
    records,
    get cellsUsed() {
      return cellsUsed;
    },
    get cellBudget() {
      return cellBudget;
    },
    get remaining() {
      return Math.max(0, cellBudget - cellsUsed);
    },
    get isDead() {
      return dead;
    },
    async runSchemaExtraction(files) {
      if (files.length === 0) return null;
      const code = buildSchemaExtractionCode(files);
      return executeOne(code, 'schema');
    },
    async processDraft(draft, phase) {
      const blocks = parseExecuteCodeBlocks(draft);
      if (blocks.length === 0) return { draft, records: [] };
      const slicedRecords: CodeExecutionRecord[] = [];
      let out = '';
      let cursor = 0;
      for (const block of blocks) {
        out += draft.slice(cursor, block.start);
        cursor = block.end;
        if (dead || cellsUsed >= cellBudget) {
          out += `\n[Code cell skipped — execution budget exhausted (${cellsUsed}/${cellBudget})]\n`;
          continue;
        }
        const rec = await executeOne(block.code, phase);
        if (rec) {
          slicedRecords.push(rec);
          out += formatCellOutputForDraft(rec);
        } else {
          out += `\n[Code cell skipped — sandbox unavailable]\n`;
        }
      }
      out += draft.slice(cursor);
      return { draft: out, records: slicedRecords };
    },
  };
}
