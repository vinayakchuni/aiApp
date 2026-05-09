import type { MessageRole } from '../generated/prisma/enums';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.';

export interface BuildContextOptions {
  systemPrompt?: string;
  history: HistoryMessage[];
}

export function buildModelMessages({
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  history,
}: BuildContextOptions): LLMMessage[] {
  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];

  // Future: file content messages get injected here, between system prompt and history.

  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  return messages;
}
