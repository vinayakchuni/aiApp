import { prisma } from '../lib/db';
import { generateAssistantText } from './ai';
import { DEFAULT_MODEL_ID, isSupportedModel } from './models';
import type { LLMMessage } from './context';

export const CLARIFYING_QUESTION_COUNT = 4;

const CLARIFYING_SYSTEM_PROMPT = `You are a research planning assistant. The user has just given you a research topic. Your job is to ask ${CLARIFYING_QUESTION_COUNT} concise clarifying questions covering scope, depth, focus, and intended audience or use case. Number the questions 1-${CLARIFYING_QUESTION_COUNT}. Do not start the research yet - only ask the questions. Do not include any preamble.`;

const PROCESS_ANSWERS_SYSTEM_PROMPT = `You are a research planning assistant. You previously asked clarifying questions about a research topic. The user has now answered.

Decide whether you have enough information to begin in-depth research. Respond in EXACTLY one of these two formats and nothing else:

READY: <one-sentence summary of the agreed research scope>

or

QUESTIONS:
1. <follow-up question>
2. <follow-up question>
3. <follow-up question>

Use READY only if the answers fully cover scope, depth, and focus. Otherwise ask up to 3 sharper follow-up questions. Do not include other commentary.`;

export type StartResearchOutcome =
  | { kind: 'ok'; userMessage: Awaited<ReturnType<typeof prisma.message.create>>; assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>; conversation: Awaited<ReturnType<typeof prisma.conversation.update>> }
  | { kind: 'not-found' }
  | { kind: 'wrong-mode' }
  | { kind: 'wrong-status' }
  | { kind: 'ai-error' };

export type ProcessAnswerOutcome =
  | {
      kind: 'questions';
      userMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      conversation: Awaited<ReturnType<typeof prisma.conversation.update>>;
    }
  | {
      kind: 'ready';
      userMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      conversation: Awaited<ReturnType<typeof prisma.conversation.update>>;
    };

function modelIdFor(preferredModel: string | null | undefined): string {
  if (preferredModel && isSupportedModel(preferredModel)) return preferredModel;
  return DEFAULT_MODEL_ID;
}

export function parseClarifyingQuestions(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const questions: string[] = [];
  const numbered = /^\s*(?:\d+[.)]|[-*•])\s*(.+)$/;
  for (const line of lines) {
    const match = line.match(numbered);
    if (match) {
      questions.push(match[1].trim());
    }
  }
  if (questions.length === 0) {
    return lines.slice(0, CLARIFYING_QUESTION_COUNT);
  }
  return questions;
}

export interface ProcessAnswerParseResult {
  ready: boolean;
  text: string;
  questions: string[];
  summary?: string;
}

export function parseProcessAnswerResponse(text: string): ProcessAnswerParseResult {
  const trimmed = text.trim();
  const readyMatch = trimmed.match(/^READY:\s*(.+)/is);
  if (readyMatch) {
    return {
      ready: true,
      text: trimmed,
      questions: [],
      summary: readyMatch[1].trim(),
    };
  }
  const questions = parseClarifyingQuestions(
    trimmed.replace(/^QUESTIONS:\s*/i, '').trim(),
  );
  return { ready: false, text: trimmed, questions };
}

export async function startResearch(
  userId: string,
  conversationId: string,
  topic: string,
): Promise<StartResearchOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      mode: true,
      researchStatus: true,
      user: { select: { preferredModel: true } },
    },
  });
  if (!conversation || conversation.userId !== userId) {
    return { kind: 'not-found' };
  }
  if (conversation.mode !== 'research') {
    return { kind: 'wrong-mode' };
  }
  if (conversation.researchStatus !== 'idle') {
    return { kind: 'wrong-status' };
  }

  const userMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'user',
      content: topic,
    },
  });

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: CLARIFYING_SYSTEM_PROMPT },
    { role: 'user', content: topic },
  ];

  let questionsText: string;
  try {
    questionsText = await generateAssistantText(
      llmMessages,
      modelIdFor(conversation.user?.preferredModel),
    );
  } catch (err) {
    console.error('Clarifying-questions LLM call failed:', err);
    return { kind: 'ai-error' };
  }

  const questions = parseClarifyingQuestions(questionsText);
  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      content: questionsText,
      metadata: { kind: 'clarifying_questions', questions },
    },
  });

  const updatedConversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { researchStatus: 'clarifying', updatedAt: new Date() },
  });

  return {
    kind: 'ok',
    userMessage,
    assistantMessage,
    conversation: updatedConversation,
  };
}

export async function processClarifyingAnswer(
  userId: string,
  conversationId: string,
  content: string,
): Promise<
  | ProcessAnswerOutcome
  | { kind: 'not-found' }
  | { kind: 'wrong-mode' }
  | { kind: 'wrong-status' }
  | { kind: 'ai-error' }
> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      mode: true,
      researchStatus: true,
      user: { select: { preferredModel: true } },
    },
  });
  if (!conversation || conversation.userId !== userId) {
    return { kind: 'not-found' };
  }
  if (conversation.mode !== 'research') {
    return { kind: 'wrong-mode' };
  }
  if (conversation.researchStatus !== 'clarifying') {
    return { kind: 'wrong-status' };
  }

  const userMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'user',
      content,
    },
  });

  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: PROCESS_ANSWERS_SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  let responseText: string;
  try {
    responseText = await generateAssistantText(
      llmMessages,
      modelIdFor(conversation.user?.preferredModel),
    );
  } catch (err) {
    console.error('Process-answer LLM call failed:', err);
    return { kind: 'ai-error' };
  }

  const parsed = parseProcessAnswerResponse(responseText);

  if (parsed.ready) {
    const assistantMessage = await prisma.message.create({
      data: {
        conversationId,
        role: 'assistant',
        content: responseText,
        metadata: { kind: 'research_ready', summary: parsed.summary },
      },
    });
    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { researchStatus: 'researching', updatedAt: new Date() },
    });
    return {
      kind: 'ready',
      userMessage,
      assistantMessage,
      conversation: updatedConversation,
    };
  }

  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      content: responseText,
      metadata: { kind: 'clarifying_questions', questions: parsed.questions },
    },
  });

  const updatedConversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  return {
    kind: 'questions',
    userMessage,
    assistantMessage,
    conversation: updatedConversation,
  };
}
