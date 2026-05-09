import { openai } from '@ai-sdk/openai';
import { generateText, streamText, type LanguageModel } from 'ai';
import type { LLMMessage } from './context';

const DEFAULT_MODEL_ID = 'gpt-4o-mini';

export function defaultModel(): LanguageModel {
  return openai(DEFAULT_MODEL_ID);
}

export interface AssistantTextStream {
  textStream: AsyncIterable<string>;
}

export function streamAssistantText(messages: LLMMessage[]): AssistantTextStream {
  return streamText({
    model: defaultModel(),
    messages,
  });
}

export async function generateAssistantText(messages: LLMMessage[]): Promise<string> {
  const result = await generateText({
    model: defaultModel(),
    messages,
  });
  return result.text;
}
