import { describe, it, expect } from 'vitest';
import {
  MODEL_PRICING,
  calculateCost,
  getModelPricing,
  isKnownModel,
} from '../services/cost';

describe('cost calculator', () => {
  describe('MODEL_PRICING table', () => {
    it('covers every supported model in the SUPPORTED_MODELS list', () => {
      const expected = [
        'openai:gpt-4o-mini',
        'openai:gpt-4o',
        'anthropic:claude-3-5-sonnet-latest',
        'anthropic:claude-3-5-haiku-latest',
        'ollama:llama3.1',
      ];
      for (const id of expected) {
        expect(MODEL_PRICING).toHaveProperty(id);
      }
    });

    it('exposes input and output prices as positive numbers', () => {
      for (const [id, pricing] of Object.entries(MODEL_PRICING)) {
        expect(Number.isFinite(pricing.inputPerMillion)).toBe(true);
        expect(pricing.inputPerMillion).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(pricing.outputPerMillion)).toBe(true);
        expect(pricing.outputPerMillion).toBeGreaterThanOrEqual(0);
        expect(id).toContain(':');
      }
    });
  });

  describe('isKnownModel', () => {
    it('returns true for supported ids', () => {
      expect(isKnownModel('openai:gpt-4o-mini')).toBe(true);
      expect(isKnownModel('ollama:llama3.1')).toBe(true);
    });

    it('returns false for unsupported ids', () => {
      expect(isKnownModel('openai:gpt-99')).toBe(false);
      expect(isKnownModel('')).toBe(false);
    });
  });

  describe('getModelPricing', () => {
    it('returns the pricing object for a known model', () => {
      const pricing = getModelPricing('openai:gpt-4o-mini');
      expect(pricing).toEqual({ inputPerMillion: 0.15, outputPerMillion: 0.6 });
    });

    it('returns null for unknown models', () => {
      expect(getModelPricing('openai:gpt-99')).toBeNull();
    });
  });

  describe('calculateCost', () => {
    it('computes input + output cost for a known model', () => {
      const cost = calculateCost('openai:gpt-4o-mini', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost.inputCost).toBeCloseTo(0.15, 10);
      expect(cost.outputCost).toBeCloseTo(0.6, 10);
      expect(cost.totalCost).toBeCloseTo(0.75, 10);
    });

    it('scales linearly for small token counts', () => {
      const cost = calculateCost('openai:gpt-4o-mini', {
        inputTokens: 100,
        outputTokens: 200,
      });
      expect(cost.inputCost).toBeCloseTo((100 / 1_000_000) * 0.15, 12);
      expect(cost.outputCost).toBeCloseTo((200 / 1_000_000) * 0.6, 12);
      expect(cost.totalCost).toBeCloseTo(cost.inputCost + cost.outputCost, 12);
    });

    it('returns zero cost when both token counts are zero', () => {
      const cost = calculateCost('openai:gpt-4o-mini', {
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(cost).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 });
    });

    it('treats undefined and null token counts as zero', () => {
      const undef = calculateCost('openai:gpt-4o-mini', {});
      expect(undef).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 });
      const nulled = calculateCost('openai:gpt-4o-mini', {
        inputTokens: null,
        outputTokens: null,
      });
      expect(nulled).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 });
    });

    it('returns zero cost for unknown models (fallback)', () => {
      const cost = calculateCost('openai:gpt-99', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 });
    });

    it('returns zero cost for the local Ollama model (free)', () => {
      const cost = calculateCost('ollama:llama3.1', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 });
    });

    it('computes Anthropic Sonnet cost correctly', () => {
      const cost = calculateCost('anthropic:claude-3-5-sonnet-latest', {
        inputTokens: 500_000,
        outputTokens: 250_000,
      });
      expect(cost.inputCost).toBeCloseTo(1.5, 10);
      expect(cost.outputCost).toBeCloseTo(3.75, 10);
      expect(cost.totalCost).toBeCloseTo(5.25, 10);
    });

    it('computes Anthropic Haiku cost correctly', () => {
      const cost = calculateCost('anthropic:claude-3-5-haiku-latest', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost.inputCost).toBeCloseTo(0.8, 10);
      expect(cost.outputCost).toBeCloseTo(4, 10);
      expect(cost.totalCost).toBeCloseTo(4.8, 10);
    });
  });
});
