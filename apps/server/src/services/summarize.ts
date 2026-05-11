import { prisma } from '../lib/db';
import { generateAssistantText } from './ai';
import type { LLMMessage } from './context';
import { DEFAULT_MODEL_ID, isSupportedModel } from './models';

export const SUMMARY_TARGET_WORDS = 250;
const MAX_INPUT_CHARS = 80_000;

const SUMMARY_SYSTEM_PROMPT = `You are a research assistant summarizing a document so another LLM can decide whether to pull it in for deeper context. Produce a concise summary of about ${SUMMARY_TARGET_WORDS} words covering: the document's topic, the key claims or findings, the kind of evidence presented, and any notable scope or limitations. Do not editorialize or invent facts. If the document is too short to summarize meaningfully, return the trimmed original text.`;

export function buildSummarizePrompt(originalName: string, text: string): LLMMessage[] {
  const truncated = text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n\n[...truncated for summarization]` : text;
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `DOCUMENT NAME: ${originalName}\n\nDOCUMENT TEXT:\n${truncated}`,
    },
  ];
}

function modelIdFor(preferredModel: string | null | undefined): string {
  if (preferredModel && isSupportedModel(preferredModel)) return preferredModel;
  return DEFAULT_MODEL_ID;
}

export type SummarizeFileOutcome =
  | { kind: 'ok'; summary: string }
  | { kind: 'not-found' }
  | { kind: 'already-summarized' }
  | { kind: 'ai-error'; error: unknown };

export interface SummarizeFileOptions {
  preferredModel?: string | null;
  force?: boolean;
}

export async function summarizeFile(
  fileId: string,
  options: SummarizeFileOptions = {},
): Promise<SummarizeFileOutcome> {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      originalName: true,
      extractedText: true,
      summary: true,
    },
  });
  if (!file) return { kind: 'not-found' };
  if (file.summary && !options.force) {
    return { kind: 'already-summarized' };
  }

  const text = file.extractedText.trim();
  if (text.length === 0) {
    await prisma.file.update({
      where: { id: fileId },
      data: { summary: '' },
    });
    return { kind: 'ok', summary: '' };
  }

  let summary: string;
  try {
    summary = await generateAssistantText(
      buildSummarizePrompt(file.originalName, text),
      modelIdFor(options.preferredModel),
    );
  } catch (err) {
    console.error(`File summarization failed for ${fileId}:`, err);
    return { kind: 'ai-error', error: err };
  }

  const trimmed = summary.trim();
  await prisma.file.update({
    where: { id: fileId },
    data: { summary: trimmed },
  });

  return { kind: 'ok', summary: trimmed };
}
