import { generateAssistantText, type TracingContext } from './ai';
import { DEFAULT_MODEL_ID } from './models';
import type { LLMMessage } from './context';

export const IMPORT_WHITELIST: readonly string[] = [
  'pandas',
  'numpy',
  'openpyxl',
  'csv',
  'json',
  're',
  'math',
  'datetime',
  'collections',
  'itertools',
  'functools',
  'matplotlib',
  'seaborn',
  'sklearn',
  'statsmodels',
  'scipy',
  'os.path',
  'io',
  'warnings',
  'typing',
];

export const CODE_REVIEW_SYSTEM_PROMPT = `You are a security reviewer for Python code that will run inside a locked-down sandbox container as part of a data-analysis pipeline. Your job is to decide whether a code cell is SAFE or UNSAFE to execute.

ALLOWED IMPORTS (top-level module — submodules of these are fine):
${IMPORT_WHITELIST.map((m) => `- ${m}`).join('\n')}

The cell is UNSAFE if ANY of the following apply:
1. It imports a module not on the allowlist above (e.g. subprocess, socket, requests, urllib, http, ftplib, pickle, ctypes, pty, multiprocessing, threading, asyncio, sys, os without going through os.path, shutil, pathlib for writes, importlib, builtins, __import__).
2. It writes to the filesystem outside /tmp, /sandbox/work, or /sandbox/data (e.g. open('/etc/passwd', 'w'), Path.home() writes, anything touching '/' or '~' for write).
3. It reads or modifies environment variables (os.environ, os.getenv, os.putenv).
4. It uses eval(), exec(), compile(), or __import__() with dynamic/constructed strings, or accesses dunder attributes like __class__, __subclasses__, __globals__, __builtins__.
5. It reads system information from sys, os.uname, platform, socket.gethostname, or similar.
6. It attempts network I/O of any kind.
7. It uses os.system, os.popen, os.spawn*, os.exec*, or any subprocess facility.

The cell is SAFE if it only uses allowlisted imports for legitimate data analysis (loading CSV/XLSX, transforming DataFrames, plotting, statistics, modeling). Reading data files from /sandbox/data is allowed. Writing scratch files to /tmp is allowed.

Respond with EXACTLY ONE line in one of these two formats and nothing else:
SAFE
UNSAFE: <one-sentence reason>`;

export interface CodeReviewResult {
  safe: boolean;
  reason?: string;
}

export interface ReviewCodeOptions {
  modelId?: string;
  traceParent?: TracingContext;
  generateFn?: typeof generateAssistantText;
  abortSignal?: AbortSignal;
}

export function buildCodeReviewMessages(code: string): LLMMessage[] {
  return [
    { role: 'system', content: CODE_REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `CODE:\n\`\`\`python\n${code}\n\`\`\`` },
  ];
}

export function parseCodeReview(text: string): CodeReviewResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { safe: false, reason: 'empty review response' };
  }
  const firstLine = trimmed.split('\n')[0].trim();
  if (/^safe\b/i.test(firstLine) && !/^unsafe\b/i.test(firstLine)) {
    return { safe: true };
  }
  const unsafeMatch = firstLine.match(/^unsafe\s*[:\-–]?\s*(.*)$/i);
  if (unsafeMatch) {
    const reason = unsafeMatch[1].trim();
    return { safe: false, reason: reason.length > 0 ? reason : 'unsafe (no reason given)' };
  }
  return { safe: false, reason: `unparseable review response: ${firstLine.slice(0, 200)}` };
}

export async function reviewCode(
  code: string,
  options: ReviewCodeOptions = {},
): Promise<CodeReviewResult> {
  const {
    modelId = DEFAULT_MODEL_ID,
    traceParent,
    generateFn = generateAssistantText,
    abortSignal,
  } = options;

  if (code.trim().length === 0) {
    return { safe: false, reason: 'empty code cell' };
  }

  let responseText: string;
  try {
    responseText = await generateFn(buildCodeReviewMessages(code), modelId, {
      trace: traceParent,
      generationName: 'code-review',
    });
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `code-review LLM failed: ${message}` };
  }

  return parseCodeReview(responseText);
}
