// Per-million-token USD prices for supported models. Prices last reviewed
// 2026-05-11 against public OpenAI / Anthropic pricing pages; update when
// model prices change. Ollama models are self-hosted and treated as free.
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'openai:gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'openai:gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'anthropic:claude-3-5-sonnet-latest': {
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
  'anthropic:claude-3-5-haiku-latest': {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
  },
  'ollama:llama3.1': { inputPerMillion: 0, outputPerMillion: 0 },
});

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export interface CostInputs {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export function getModelPricing(modelId: string): ModelPricing | null {
  return MODEL_PRICING[modelId] ?? null;
}

export function calculateCost(modelId: string, usage: CostInputs): CostBreakdown {
  const pricing = getModelPricing(modelId);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (!pricing) {
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

export function isKnownModel(modelId: string): boolean {
  return modelId in MODEL_PRICING;
}
