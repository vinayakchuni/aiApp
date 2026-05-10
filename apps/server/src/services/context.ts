import type { MessageRole } from '../generated/prisma/enums';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

export interface FileContext {
  originalName: string;
  extractedText: string;
}

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.';

export interface BuildContextOptions {
  systemPrompt?: string;
  history: HistoryMessage[];
  files?: FileContext[];
}

export function fileContextMessage(file: FileContext): string {
  return `[Uploaded file: ${file.originalName}]\n${file.extractedText}\n[End of file: ${file.originalName}]`;
}

export function buildModelMessages({
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  history,
  files = [],
}: BuildContextOptions): LLMMessage[] {
  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const file of files) {
    messages.push({ role: 'system', content: fileContextMessage(file) });
  }

  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  return messages;
}
