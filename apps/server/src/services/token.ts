import { randomBytes } from 'crypto';
import { prisma } from '../lib/db';
import type { TokenType } from '../generated/prisma/client';

const TOKEN_EXPIRY_MS: Record<TokenType, number> = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000, // 24 hours
  PASSWORD_RESET: 60 * 60 * 1000, // 1 hour
};

export async function generateVerificationToken({
  userId,
  type,
}: {
  userId: string;
  type: TokenType;
}): Promise<string> {
  // Delete any existing tokens of the same type for this user
  await prisma.verificationToken.deleteMany({
    where: { userId, type },
  });

  const token = randomBytes(32).toString('hex');

  await prisma.verificationToken.create({
    data: {
      userId,
      token,
      type,
      expiresAt: new Date(Date.now() + TOKEN_EXPIRY_MS[type]),
    },
  });

  return token;
}

export async function validateToken({
  token,
  type,
}: {
  token: string;
  type: TokenType;
}) {
  const tokenRecord = await prisma.verificationToken.findUnique({
    where: { token },
  });

  if (!tokenRecord) return null;
  if (tokenRecord.type !== type) return null;
  if (tokenRecord.expiresAt < new Date()) return null;

  return tokenRecord;
}

export async function consumeToken(tokenId: string) {
  await prisma.verificationToken.delete({
    where: { id: tokenId },
  });
}
