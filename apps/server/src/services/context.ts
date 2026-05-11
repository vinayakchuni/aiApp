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

export interface ResearchContextSource {
  index: number;
  title: string;
  url: string;
}

export interface ResearchContext {
  topic: string;
  executiveSummary: string;
  keyFindings: string[];
  sources: ResearchContextSource[];
}

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.';

export interface BuildContextOptions {
  systemPrompt?: string;
  history: HistoryMessage[];
  files?: FileContext[];
  researchContext?: ResearchContext | null;
}

export function fileContextMessage(file: FileContext): string {
  return `[Uploaded file: ${file.originalName}]\n${file.extractedText}\n[End of file: ${file.originalName}]`;
}

export function researchContextMessage(ctx: ResearchContext): string {
  const sourceLines = ctx.sources
    .map((s) => `[${s.index}] ${s.title} — ${s.url}`)
    .join('\n');
  const findingLines = ctx.keyFindings.map((f) => `- ${f}`).join('\n');
  return `[Research context for follow-up questions]
TOPIC: ${ctx.topic}

EXECUTIVE SUMMARY:
${ctx.executiveSummary}

KEY FINDINGS:
${findingLines || '(none)'}

SOURCES (cite as [n]):
${sourceLines || '(none)'}

When answering follow-up questions, use the research context above and the prior assistant message that contains the full draft. If the user asks for more detail, expand the relevant section using the supplied sources; do not invent new facts.
[End of research context]`;
}

export function buildModelMessages({
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  history,
  files = [],
  researchContext = null,
}: BuildContextOptions): LLMMessage[] {
  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const file of files) {
    messages.push({ role: 'system', content: fileContextMessage(file) });
  }

  if (researchContext) {
    messages.push({
      role: 'system',
      content: researchContextMessage(researchContext),
    });
  }

  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  return messages;
}
