import { prisma } from '../lib/db';
import type { ConversationMode } from '../generated/prisma/enums';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';
export const AUTO_TITLE_MAX_LENGTH = 50;
const DEFAULT_MAX_MESSAGES = 100;

export function getMaxMessagesPerConversation(): number {
  const raw = process.env.MAX_MESSAGES_PER_CONVERSATION;
  if (!raw) return DEFAULT_MAX_MESSAGES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MESSAGES;
}

type Message = Awaited<ReturnType<typeof prisma.message.create>>;
type HistoryEntry = { role: 'user' | 'assistant' | 'system'; content: string };

export type AppendUserMessageOutcome =
  | { kind: 'ok'; userMessage: Message; history: HistoryEntry[] }
  | { kind: 'not-found' }
  | { kind: 'too-many-messages' };

export interface CreateConversationOptions {
  title?: string;
  mode?: ConversationMode;
}

export async function createConversation(
  userId: string,
  options: CreateConversationOptions = {},
) {
  const { title, mode } = options;
  return prisma.conversation.create({
    data: {
      userId,
      ...(title ? { title } : {}),
      ...(mode ? { mode } : {}),
    },
  });
}

export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string,
) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });

  if (!conversation || conversation.userId !== userId) {
    return null;
  }

  return prisma.conversation.update({
    where: { id: conversationId },
    data: { title },
  });
}

export type SetModeOutcome =
  | { kind: 'ok'; conversation: Awaited<ReturnType<typeof prisma.conversation.update>> }
  | { kind: 'not-found' }
  | { kind: 'has-messages' };

export async function setConversationMode(
  userId: string,
  conversationId: string,
  mode: ConversationMode,
): Promise<SetModeOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      mode: true,
      _count: { select: { messages: true } },
    },
  });

  if (!conversation || conversation.userId !== userId) {
    return { kind: 'not-found' };
  }

  if (conversation.mode === mode) {
    const unchanged = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    return { kind: 'ok', conversation: unchanged };
  }

  if (conversation._count.messages > 0) {
    return { kind: 'has-messages' };
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      mode,
      researchStatus: 'idle',
    },
  });
  return { kind: 'ok', conversation: updated };
}

export async function deleteConversation(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });

  if (!conversation || conversation.userId !== userId) {
    return false;
  }

  await prisma.conversation.delete({ where: { id: conversationId } });
  return true;
}

export async function listConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function getConversationForUser(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
      files: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          conversationId: true,
          originalName: true,
          mimeType: true,
          size: true,
          createdAt: true,
        },
      },
    },
  });

  if (!conversation || conversation.userId !== userId) {
    return null;
  }

  return conversation;
}

export async function appendUserMessage(
  userId: string,
  conversationId: string,
  content: string,
): Promise<AppendUserMessageOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, title: true },
  });

  if (!conversation || conversation.userId !== userId) {
    return { kind: 'not-found' };
  }

  const messageCount = await prisma.message.count({
    where: { conversationId },
  });
  if (messageCount >= getMaxMessagesPerConversation()) {
    return { kind: 'too-many-messages' };
  }

  const userMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'user',
      content,
    },
  });

  if (conversation.title === DEFAULT_CONVERSATION_TITLE) {
    const autoTitle = content.trim().slice(0, AUTO_TITLE_MAX_LENGTH);
    if (autoTitle.length > 0) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { title: autoTitle },
      });
    }
  }

  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  return { kind: 'ok', userMessage, history };
}

export async function appendAssistantMessage(conversationId: string, content: string) {
  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      content,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  return assistantMessage;
}
