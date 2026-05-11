import {
  Langfuse,
  type LangfuseSpanClient,
  type LangfuseTraceClient,
} from 'langfuse';
import { calculateCost, type CostBreakdown } from './cost';

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';

let cachedClient: Langfuse | null | undefined;

function safe<T>(fn: () => T, fallback: T, context: string): T {
  try {
    return fn();
  } catch (err) {
    console.warn(`Langfuse ${context} failed; tracing skipped:`, err);
    return fallback;
  }
}

export function getLangfuseClient(): Langfuse | null {
  if (cachedClient !== undefined) return cachedClient;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    cachedClient = null;
    return null;
  }
  cachedClient = safe(
    () =>
      new Langfuse({
        publicKey,
        secretKey,
        baseUrl: process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL,
      }),
    null,
    'client init',
  );
  return cachedClient;
}

// Reset for tests; not for production code.
export function _resetLangfuseClient(): void {
  cachedClient = undefined;
}

export interface PhaseSpanUpdate {
  metadata?: Record<string, unknown>;
  output?: unknown;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
  statusMessage?: string;
}

export interface GenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface StartGenerationOptions {
  modelId: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface EndGenerationOptions {
  output?: unknown;
  usage?: GenerationUsage;
  metadata?: Record<string, unknown>;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
  statusMessage?: string;
}

export interface GenerationSpan {
  end(opts?: EndGenerationOptions): void;
}

export interface StartSpanOptions {
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PhaseSpan {
  update(body: PhaseSpanUpdate): void;
  end(body?: PhaseSpanUpdate): void;
  startGeneration(name: string, opts: StartGenerationOptions): GenerationSpan;
  startSpan(name: string, opts?: StartSpanOptions): PhaseSpan;
}

export interface FinishTraceOptions {
  output?: unknown;
  metadata?: Record<string, unknown>;
  exitReason?: string;
  error?: string;
}

export type ScoreDataType = 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL';

export interface ScoreOptions {
  comment?: string;
  metadata?: Record<string, unknown>;
  dataType?: ScoreDataType;
}

export interface TraceCostTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  generations: number;
}

export interface ResearchTrace {
  isEnabled: boolean;
  startSpan(name: string, opts?: StartSpanOptions): PhaseSpan;
  startGeneration(name: string, opts: StartGenerationOptions): GenerationSpan;
  updateMetadata(patch: Record<string, unknown>): void;
  markError(message: string): void;
  score(name: string, value: number, opts?: ScoreOptions): void;
  finish(opts?: FinishTraceOptions): Promise<void>;
  getCostTotals(): TraceCostTotals;
}

export interface ResearchTraceInit {
  userId: string;
  conversationId: string;
  topic: string;
  modelId: string;
  clarifyingAnswers: string[];
  scopeSummary?: string;
}

const noopGeneration: GenerationSpan = {
  end() {},
};

const noopSpan: PhaseSpan = {
  update() {},
  end() {},
  startGeneration: () => noopGeneration,
  startSpan: () => noopSpan,
};

const zeroTotals: TraceCostTotals = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputCost: 0,
  outputCost: 0,
  totalCost: 0,
  generations: 0,
});

const noopTrace: ResearchTrace = {
  isEnabled: false,
  startSpan: () => noopSpan,
  startGeneration: () => noopGeneration,
  updateMetadata() {},
  markError() {},
  score() {},
  async finish() {},
  getCostTotals: () => zeroTotals,
};

function buildGeneration(
  parent: LangfuseTraceClient | LangfuseSpanClient,
  name: string,
  opts: StartGenerationOptions,
  onEnd: (
    modelId: string,
    usage: GenerationUsage | undefined,
    cost: CostBreakdown,
  ) => void,
): GenerationSpan {
  const handle = safe(
    () =>
      parent.generation({
        name,
        model: opts.modelId,
        input: opts.input,
        metadata: opts.metadata,
        startTime: new Date(),
      }),
    null,
    `generation(${name}) create`,
  );
  if (!handle) return noopGeneration;
  return {
    end(body) {
      const usage = body?.usage;
      const cost = calculateCost(opts.modelId, {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      });
      safe(
        () =>
          void handle.end({
            output: body?.output,
            level: body?.level,
            statusMessage: body?.statusMessage,
            metadata: body?.metadata,
            usageDetails: usage
              ? {
                  input: usage.inputTokens ?? 0,
                  output: usage.outputTokens ?? 0,
                  total:
                    usage.totalTokens ??
                    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
                }
              : undefined,
            costDetails: {
              input: cost.inputCost,
              output: cost.outputCost,
              total: cost.totalCost,
            },
          }),
        undefined,
        `generation(${name}).end`,
      );
      onEnd(opts.modelId, usage, cost);
    },
  };
}

function wrapSpan(
  span: LangfuseSpanClient,
  onGenerationEnd: (
    modelId: string,
    usage: GenerationUsage | undefined,
    cost: CostBreakdown,
  ) => void,
): PhaseSpan {
  return {
    update(body) {
      safe(() => void span.update(body), undefined, 'span.update');
    },
    end(body) {
      safe(() => void span.end(body), undefined, 'span.end');
    },
    startGeneration(name, opts) {
      return buildGeneration(span, name, opts, onGenerationEnd);
    },
    startSpan(name, opts) {
      const child = safe(
        () =>
          span.span({
            name,
            input: opts?.input,
            metadata: opts?.metadata,
            startTime: new Date(),
          }),
        null,
        `span(${name}) create`,
      );
      return child ? wrapSpan(child, onGenerationEnd) : noopSpan;
    },
  };
}

export function createResearchTrace(init: ResearchTraceInit): ResearchTrace {
  const client = getLangfuseClient();
  if (!client) return noopTrace;

  const trace: LangfuseTraceClient | null = safe(
    () =>
      client.trace({
        name: 'research-pipeline',
        userId: init.userId,
        sessionId: init.conversationId,
        input: {
          topic: init.topic,
          clarifyingAnswers: init.clarifyingAnswers,
          scopeSummary: init.scopeSummary,
        },
        metadata: {
          conversationId: init.conversationId,
          modelId: init.modelId,
          clarifyingAnswers: init.clarifyingAnswers,
        },
        tags: ['research'],
      }),
    null,
    'trace create',
  );
  if (!trace) return noopTrace;

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    generations: 0,
  };

  function recordGenerationCost(
    _modelId: string,
    usage: GenerationUsage | undefined,
    cost: CostBreakdown,
  ): void {
    totals.generations += 1;
    if (usage) {
      totals.inputTokens += usage.inputTokens ?? 0;
      totals.outputTokens += usage.outputTokens ?? 0;
      totals.totalTokens +=
        usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
    totals.inputCost += cost.inputCost;
    totals.outputCost += cost.outputCost;
    totals.totalCost += cost.totalCost;
  }

  return {
    isEnabled: true,
    startSpan(name, opts) {
      const span = safe(
        () =>
          trace.span({
            name,
            input: opts?.input,
            metadata: opts?.metadata,
            startTime: new Date(),
          }),
        null,
        `span(${name}) create`,
      );
      return span ? wrapSpan(span, recordGenerationCost) : noopSpan;
    },
    startGeneration(name, opts) {
      return buildGeneration(trace, name, opts, recordGenerationCost);
    },
    updateMetadata(patch) {
      safe(() => void trace.update({ metadata: patch }), undefined, 'trace.update');
    },
    markError(message) {
      safe(
        () =>
          void trace.update({
            metadata: { error: message, status: 'ERROR' },
            output: { error: message },
          }),
        undefined,
        'trace.markError',
      );
    },
    score(name, value, opts) {
      safe(
        () =>
          void trace.score({
            name,
            value,
            comment: opts?.comment,
            metadata: opts?.metadata,
            dataType: opts?.dataType ?? 'NUMERIC',
          }),
        undefined,
        `trace.score(${name})`,
      );
    },
    getCostTotals: () => ({ ...totals }),
    async finish(opts) {
      const patch: Parameters<LangfuseTraceClient['update']>[0] = {};
      if (opts?.output !== undefined) patch.output = opts.output;
      const metadata: Record<string, unknown> = { ...(opts?.metadata ?? {}) };
      if (opts?.exitReason !== undefined) metadata.exitReason = opts.exitReason;
      if (opts?.error !== undefined) {
        metadata.error = opts.error;
        metadata.status = 'ERROR';
      }
      if (totals.generations > 0) {
        metadata.totalInputTokens = totals.inputTokens;
        metadata.totalOutputTokens = totals.outputTokens;
        metadata.totalTokens = totals.totalTokens;
        metadata.totalCostUsd = totals.totalCost;
        metadata.generationsCount = totals.generations;
      }
      if (Object.keys(metadata).length > 0) patch.metadata = metadata;
      if (Object.keys(patch).length > 0) {
        safe(() => void trace.update(patch), undefined, 'trace.finish.update');
      }
      try {
        await client.flushAsync();
      } catch (err) {
        console.warn('Langfuse flushAsync failed:', err);
      }
    },
  };
}

