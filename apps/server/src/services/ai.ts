import { generateText, streamText, type LanguageModel } from 'ai';
import type { LLMMessage } from './context';
import { DEFAULT_MODEL_ID, resolveModel } from './models';

export function defaultModel(): LanguageModel {
  return resolveModel(DEFAULT_MODEL_ID);
}

export interface AssistantTextStream {
  textStream: AsyncIterable<string>;
}

export function streamAssistantText(
  messages: LLMMessage[],
  modelId: string = DEFAULT_MODEL_ID,
  abortSignal?: AbortSignal,
): AssistantTextStream {
  return streamText({
    model: resolveModel(modelId),
    messages,
    abortSignal,
  });
}

export async function generateAssistantText(
  messages: LLMMessage[],
  modelId: string = DEFAULT_MODEL_ID,
): Promise<string> {
  const result = await generateText({
    model: resolveModel(modelId),
    messages,
  });
  return result.text;
}
