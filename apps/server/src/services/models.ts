import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createOllama } from 'ollama-ai-provider-v2';
import type { LanguageModel } from 'ai';

export type ProviderId = 'openai' | 'anthropic' | 'ollama';

export interface ModelOption {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
}

export const SUPPORTED_MODELS: readonly ModelOption[] = [
  { id: 'openai:gpt-4o-mini', provider: 'openai', model: 'gpt-4o-mini', label: 'OpenAI · GPT-4o mini' },
  { id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', label: 'OpenAI · GPT-4o' },
  { id: 'anthropic:claude-3-5-sonnet-latest', provider: 'anthropic', model: 'claude-3-5-sonnet-latest', label: 'Anthropic · Claude 3.5 Sonnet' },
  { id: 'anthropic:claude-3-5-haiku-latest', provider: 'anthropic', model: 'claude-3-5-haiku-latest', label: 'Anthropic · Claude 3.5 Haiku' },
  { id: 'ollama:llama3.1', provider: 'ollama', model: 'llama3.1', label: 'Ollama · Llama 3.1 (local)' },
];

export const DEFAULT_MODEL_ID = 'openai:gpt-4o-mini';

export function isSupportedModel(id: string): boolean {
  return SUPPORTED_MODELS.some((m) => m.id === id);
}

export function parseModelId(id: string): { provider: ProviderId; model: string } | null {
  const colon = id.indexOf(':');
  if (colon <= 0 || colon === id.length - 1) return null;
  const provider = id.slice(0, colon);
  const model = id.slice(colon + 1);
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'ollama') return null;
  return { provider, model };
}

export function resolveModel(id: string): LanguageModel {
  if (!isSupportedModel(id)) {
    throw new Error(`Unsupported model: ${id}`);
  }
  const parsed = parseModelId(id);
  if (!parsed) {
    throw new Error(`Invalid model identifier: ${id}`);
  }
  switch (parsed.provider) {
    case 'openai':
      return openai(parsed.model);
    case 'anthropic':
      return anthropic(parsed.model);
    case 'ollama': {
      const baseURL = process.env.OLLAMA_BASE_URL;
      const ollama = baseURL ? createOllama({ baseURL }) : createOllama();
      return ollama(parsed.model);
    }
  }
}
