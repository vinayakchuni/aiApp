import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('langfuse', () => {
  const traceUpdate = vi.fn();
  const spanUpdate = vi.fn();
  const spanEnd = vi.fn();
  const traceSpan = vi.fn(() => ({ update: spanUpdate, end: spanEnd }));
  const flushAsync = vi.fn().mockResolvedValue(undefined);
  const traceCreate = vi.fn(() => ({
    update: traceUpdate,
    span: traceSpan,
  }));
  class FakeLangfuse {
    trace = traceCreate;
    flushAsync = flushAsync;
  }
  return {
    Langfuse: FakeLangfuse,
    __mocks: { traceUpdate, spanUpdate, spanEnd, traceSpan, flushAsync, traceCreate },
  };
});

import {
  createResearchTrace,
  getLangfuseClient,
  _resetLangfuseClient,
} from '../services/tracing';
import * as langfuseMock from 'langfuse';

const mocks = (langfuseMock as unknown as {
  __mocks: {
    traceUpdate: ReturnType<typeof vi.fn>;
    spanUpdate: ReturnType<typeof vi.fn>;
    spanEnd: ReturnType<typeof vi.fn>;
    traceSpan: ReturnType<typeof vi.fn>;
    flushAsync: ReturnType<typeof vi.fn>;
    traceCreate: ReturnType<typeof vi.fn>;
  };
}).__mocks;

describe('tracing service', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mocks.traceUpdate.mockReset();
    mocks.spanUpdate.mockReset();
    mocks.spanEnd.mockReset();
    mocks.traceSpan.mockReset();
    mocks.traceSpan.mockImplementation(() => ({
      update: mocks.spanUpdate,
      end: mocks.spanEnd,
    }));
    mocks.flushAsync.mockReset();
    mocks.flushAsync.mockResolvedValue(undefined);
    mocks.traceCreate.mockReset();
    mocks.traceCreate.mockImplementation(() => ({
      update: mocks.traceUpdate,
      span: mocks.traceSpan,
    }));
    _resetLangfuseClient();
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetLangfuseClient();
  });

  describe('getLangfuseClient', () => {
    it('returns null when keys are missing', () => {
      expect(getLangfuseClient()).toBeNull();
    });

    it('returns a client when both keys are configured', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      const client = getLangfuseClient();
      expect(client).not.toBeNull();
    });

    it('caches the client across calls', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
      const a = getLangfuseClient();
      const b = getLangfuseClient();
      expect(a).toBe(b);
    });
  });

  describe('createResearchTrace without configuration', () => {
    it('returns a disabled no-op trace and does not throw', async () => {
      const trace = createResearchTrace({
        userId: 'u',
        conversationId: 'c',
        topic: 't',
        modelId: 'm',
        clarifyingAnswers: [],
      });
      expect(trace.isEnabled).toBe(false);
      const span = trace.startSpan('searching');
      span.update({ metadata: { x: 1 } });
      span.end({ metadata: { y: 2 } });
      trace.updateMetadata({ k: 'v' });
      trace.markError('boom');
      await expect(trace.finish({ exitReason: 'all_passed' })).resolves.toBeUndefined();
      expect(mocks.traceCreate).not.toHaveBeenCalled();
      expect(mocks.flushAsync).not.toHaveBeenCalled();
    });
  });

  describe('createResearchTrace with configuration', () => {
    beforeEach(() => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk';
      process.env.LANGFUSE_SECRET_KEY = 'sk';
    });

    it('creates a trace and forwards span lifecycle calls', async () => {
      const trace = createResearchTrace({
        userId: 'user-1',
        conversationId: 'conv-1',
        topic: 'EU agriculture climate',
        modelId: 'openai:gpt-4o-mini',
        clarifyingAnswers: ['EU only', 'next 5 years'],
        scopeSummary: 'focus EU 2030',
      });
      expect(trace.isEnabled).toBe(true);
      expect(mocks.traceCreate).toHaveBeenCalledTimes(1);
      const traceArgs = mocks.traceCreate.mock.calls[0][0] as {
        userId: string;
        sessionId: string;
        metadata: Record<string, unknown>;
        input: Record<string, unknown>;
        tags: string[];
      };
      expect(traceArgs.userId).toBe('user-1');
      expect(traceArgs.sessionId).toBe('conv-1');
      expect(traceArgs.metadata.modelId).toBe('openai:gpt-4o-mini');
      expect(traceArgs.metadata.clarifyingAnswers).toEqual(['EU only', 'next 5 years']);
      expect(traceArgs.input.topic).toBe('EU agriculture climate');
      expect(traceArgs.tags).toEqual(['research']);

      const span = trace.startSpan('searching', { metadata: { stage: 'searching' } });
      expect(mocks.traceSpan).toHaveBeenCalledTimes(1);
      const spanArgs = mocks.traceSpan.mock.calls[0][0] as {
        name: string;
        metadata: { stage: string };
      };
      expect(spanArgs.name).toBe('searching');
      expect(spanArgs.metadata.stage).toBe('searching');

      span.update({ metadata: { progress: 1 } });
      expect(mocks.spanUpdate).toHaveBeenCalledWith({ metadata: { progress: 1 } });

      span.end({ metadata: { sources: 3 }, output: { ok: true } });
      expect(mocks.spanEnd).toHaveBeenCalledWith({
        metadata: { sources: 3 },
        output: { ok: true },
      });
    });

    it('finish merges exitReason into trace metadata and flushes', async () => {
      const trace = createResearchTrace({
        userId: 'u',
        conversationId: 'c',
        topic: 't',
        modelId: 'm',
        clarifyingAnswers: [],
      });
      await trace.finish({
        exitReason: 'all_passed',
        output: { ok: true },
        metadata: { llmCallsUsed: 4 },
      });
      expect(mocks.traceUpdate).toHaveBeenCalledTimes(1);
      const updateArg = mocks.traceUpdate.mock.calls[0][0] as {
        output: unknown;
        metadata: Record<string, unknown>;
      };
      expect(updateArg.output).toEqual({ ok: true });
      expect(updateArg.metadata).toEqual({ llmCallsUsed: 4, exitReason: 'all_passed' });
      expect(mocks.flushAsync).toHaveBeenCalledTimes(1);
    });

    it('finish records error status when finish receives an error', async () => {
      const trace = createResearchTrace({
        userId: 'u',
        conversationId: 'c',
        topic: 't',
        modelId: 'm',
        clarifyingAnswers: [],
      });
      await trace.finish({ error: 'planning LLM failed', exitReason: 'ai_error' });
      const updateArg = mocks.traceUpdate.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      };
      expect(updateArg.metadata.error).toBe('planning LLM failed');
      expect(updateArg.metadata.status).toBe('ERROR');
      expect(updateArg.metadata.exitReason).toBe('ai_error');
    });

    it('markError attaches error metadata to the trace', () => {
      const trace = createResearchTrace({
        userId: 'u',
        conversationId: 'c',
        topic: 't',
        modelId: 'm',
        clarifyingAnswers: [],
      });
      trace.markError('boom');
      const updateArg = mocks.traceUpdate.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
        output: Record<string, unknown>;
      };
      expect(updateArg.metadata.error).toBe('boom');
      expect(updateArg.metadata.status).toBe('ERROR');
      expect(updateArg.output.error).toBe('boom');
    });

    it('updateMetadata sends a patch to the trace', () => {
      const trace = createResearchTrace({
        userId: 'u',
        conversationId: 'c',
        topic: 't',
        modelId: 'm',
        clarifyingAnswers: [],
      });
      trace.updateMetadata({ foo: 'bar' });
      expect(mocks.traceUpdate).toHaveBeenCalledWith({ metadata: { foo: 'bar' } });
    });

    it('isolates internal SDK throws so the pipeline keeps running', async () => {
      mocks.traceSpan.mockImplementationOnce(() => {
        throw new Error('langfuse network error');
      });
      const trace = createResearchTrace({
        userId: 'u',
        conversationId: 'c',
        topic: 't',
        modelId: 'm',
        clarifyingAnswers: [],
      });
      const span = trace.startSpan('searching');
      expect(() => span.update({ metadata: { ok: true } })).not.toThrow();
      expect(() => span.end()).not.toThrow();
      await expect(trace.finish({ exitReason: 'all_passed' })).resolves.toBeUndefined();
    });

    it('continues when flushAsync rejects', async () => {
      mocks.flushAsync.mockRejectedValueOnce(new Error('flush down'));
      const trace = createResearchTrace({
        userId: 'u',
        conversationId: 'c',
        topic: 't',
        modelId: 'm',
        clarifyingAnswers: [],
      });
      await expect(trace.finish({ exitReason: 'all_passed' })).resolves.toBeUndefined();
    });
  });
});
