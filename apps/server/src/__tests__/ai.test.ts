import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockedGenerateText = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({
  generateText: mockedGenerateText,
  streamText: vi.fn(),
}));

vi.mock('../services/models', () => ({
  DEFAULT_MODEL_ID: 'openai:gpt-4o-mini',
  resolveModel: vi.fn(() => 'resolved-model'),
}));

import { generateAssistantText } from '../services/ai';
import type { ResearchTrace } from '../services/tracing';

interface RecordedGeneration {
  name: string;
  opts: unknown;
  end?: unknown;
}

function buildFakeTrace(): {
  trace: ResearchTrace;
  generations: RecordedGeneration[];
} {
  const generations: RecordedGeneration[] = [];
  const make = () => {
    const gen: RecordedGeneration = { name: '', opts: undefined };
    generations.push(gen);
    return {
      end: (body: unknown) => {
        gen.end = body;
      },
      _record: gen,
    };
  };
  const trace: ResearchTrace = {
    isEnabled: true,
    startSpan: () => ({
      update() {},
      end() {},
      startGeneration: (name, opts) => {
        const handle = make();
        handle._record.name = name;
        handle._record.opts = opts;
        return handle;
      },
    }),
    startGeneration: (name, opts) => {
      const handle = make();
      handle._record.name = name;
      handle._record.opts = opts;
      return handle;
    },
    updateMetadata() {},
    markError() {},
    async finish() {},
    getCostTotals: () => ({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      generations: 0,
    }),
  };
  return { trace, generations };
}

describe('generateAssistantText tracing', () => {
  beforeEach(() => {
    mockedGenerateText.mockReset();
  });

  it('returns the text and does not touch tracing when no trace is supplied', async () => {
    mockedGenerateText.mockResolvedValueOnce({
      text: 'hello',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    const text = await generateAssistantText(
      [{ role: 'user', content: 'hi' }],
      'openai:gpt-4o-mini',
    );
    expect(text).toBe('hello');
  });

  it('emits a generation on the supplied trace with usage on success', async () => {
    mockedGenerateText.mockResolvedValueOnce({
      text: 'answer',
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });
    const { trace, generations } = buildFakeTrace();
    const span = trace.startSpan('drafting');
    const text = await generateAssistantText(
      [{ role: 'user', content: 'hi' }],
      'openai:gpt-4o-mini',
      { trace: span, generationName: 'draft-generate', generationMetadata: { iteration: 1 } },
    );
    expect(text).toBe('answer');
    expect(generations).toHaveLength(1);
    expect(generations[0].name).toBe('draft-generate');
    const opts = generations[0].opts as { modelId: string; metadata: { iteration: number } };
    expect(opts.modelId).toBe('openai:gpt-4o-mini');
    expect(opts.metadata.iteration).toBe(1);
    const end = generations[0].end as {
      output: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    expect(end.output).toBe('answer');
    expect(end.usage.inputTokens).toBe(1000);
    expect(end.usage.outputTokens).toBe(500);
    expect(end.usage.totalTokens).toBe(1500);
  });

  it('marks the generation as ERROR and rethrows when generateText throws', async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error('llm exploded'));
    const { trace, generations } = buildFakeTrace();
    const span = trace.startSpan('drafting');
    await expect(
      generateAssistantText(
        [{ role: 'user', content: 'hi' }],
        'openai:gpt-4o-mini',
        { trace: span, generationName: 'draft-generate' },
      ),
    ).rejects.toThrow('llm exploded');
    expect(generations).toHaveLength(1);
    const end = generations[0].end as { level: string; statusMessage: string };
    expect(end.level).toBe('ERROR');
    expect(end.statusMessage).toContain('llm exploded');
  });

  it('falls back to "llm-call" when no generationName is supplied', async () => {
    mockedGenerateText.mockResolvedValueOnce({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const { trace, generations } = buildFakeTrace();
    await generateAssistantText(
      [{ role: 'user', content: 'hi' }],
      'openai:gpt-4o-mini',
      { trace },
    );
    expect(generations[0].name).toBe('llm-call');
  });

  it('survives undefined usage on the generateText result', async () => {
    mockedGenerateText.mockResolvedValueOnce({ text: 'ok' });
    const { trace, generations } = buildFakeTrace();
    const span = trace.startSpan('drafting');
    const text = await generateAssistantText(
      [{ role: 'user', content: 'hi' }],
      'openai:gpt-4o-mini',
      { trace: span, generationName: 'x' },
    );
    expect(text).toBe('ok');
    const end = generations[0].end as { usage: { inputTokens?: number } };
    expect(end.usage.inputTokens).toBeUndefined();
  });
});
