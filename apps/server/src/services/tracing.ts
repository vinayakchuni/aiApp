import { Langfuse, type LangfuseSpanClient, type LangfuseTraceClient } from 'langfuse';

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

export interface PhaseSpan {
  update(body: PhaseSpanUpdate): void;
  end(body?: PhaseSpanUpdate): void;
}

export interface StartSpanOptions {
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface FinishTraceOptions {
  output?: unknown;
  metadata?: Record<string, unknown>;
  exitReason?: string;
  error?: string;
}

export interface ResearchTrace {
  isEnabled: boolean;
  startSpan(name: string, opts?: StartSpanOptions): PhaseSpan;
  updateMetadata(patch: Record<string, unknown>): void;
  markError(message: string): void;
  finish(opts?: FinishTraceOptions): Promise<void>;
}

export interface ResearchTraceInit {
  userId: string;
  conversationId: string;
  topic: string;
  modelId: string;
  clarifyingAnswers: string[];
  scopeSummary?: string;
}

const noopSpan: PhaseSpan = {
  update() {},
  end() {},
};

const noopTrace: ResearchTrace = {
  isEnabled: false,
  startSpan: () => noopSpan,
  updateMetadata() {},
  markError() {},
  async finish() {},
};

function wrapSpan(span: LangfuseSpanClient): PhaseSpan {
  return {
    update(body) {
      safe(() => void span.update(body), undefined, 'span.update');
    },
    end(body) {
      safe(() => void span.end(body), undefined, 'span.end');
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
      return span ? wrapSpan(span) : noopSpan;
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
    async finish(opts) {
      const patch: Parameters<LangfuseTraceClient['update']>[0] = {};
      if (opts?.output !== undefined) patch.output = opts.output;
      const metadata: Record<string, unknown> = { ...(opts?.metadata ?? {}) };
      if (opts?.exitReason !== undefined) metadata.exitReason = opts.exitReason;
      if (opts?.error !== undefined) {
        metadata.error = opts.error;
        metadata.status = 'ERROR';
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
