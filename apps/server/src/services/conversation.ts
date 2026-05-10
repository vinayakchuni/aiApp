import { prisma } from '../lib/db';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';
export const AUTO_TITLE_MAX_LENGTH = 50;

export async function createConversation(userId: string, title?: string) {
  return prisma.conversation.create({
    data: {
      userId,
      ...(title ? { title } : {}),
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
) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, title: true },
  });

  if (!conversation || conversation.userId !== userId) {
    return null;
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

  return { userMessage, history };
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
