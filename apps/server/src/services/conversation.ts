import { prisma } from '../lib/db';

export async function createConversation(userId: string, title?: string) {
  return prisma.conversation.create({
    data: {
      userId,
      ...(title ? { title } : {}),
    },
  });
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
    },
  });

  if (!conversation || conversation.userId !== userId) {
    return null;
  }

  return conversation;
}

export async function appendUserAndEchoMessages(
  userId: string,
  conversationId: string,
  content: string,
) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
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

  return { userMessage, assistantMessage };
}
