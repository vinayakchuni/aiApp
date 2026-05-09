import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_MODELS,
  DEFAULT_MODEL_ID,
  isSupportedModel,
  parseModelId,
  resolveModel,
} from '../services/models';

describe('Model registry', () => {
  it('exposes a default model that is in the supported list', () => {
    expect(isSupportedModel(DEFAULT_MODEL_ID)).toBe(true);
  });

  it('lists models for OpenAI, Anthropic, and Ollama', () => {
    const providers = new Set(SUPPORTED_MODELS.map((m) => m.provider));
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('ollama')).toBe(true);
  });

  it('rejects unsupported model identifiers', () => {
    expect(isSupportedModel('openai:nope')).toBe(false);
    expect(isSupportedModel('not-a-model')).toBe(false);
    expect(isSupportedModel('')).toBe(false);
  });

  it('parses well-formed identifiers', () => {
    expect(parseModelId('openai:gpt-4o-mini')).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(parseModelId('anthropic:claude-3-5-sonnet-latest')).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
    });
  });

  it('rejects malformed identifiers', () => {
    expect(parseModelId('no-colon')).toBeNull();
    expect(parseModelId(':missing-provider')).toBeNull();
    expect(parseModelId('openai:')).toBeNull();
    expect(parseModelId('unknown:model')).toBeNull();
  });

  it('resolveModel returns a LanguageModel for each supported provider', () => {
    for (const m of SUPPORTED_MODELS) {
      const resolved = resolveModel(m.id);
      expect(resolved).toBeDefined();
    }
  });

  it('resolveModel throws for unsupported ids', () => {
    expect(() => resolveModel('openai:does-not-exist')).toThrow();
    expect(() => resolveModel('garbage')).toThrow();
  });
});
