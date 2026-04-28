import { prisma } from '../lib/db';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  return result.count;
}

export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.verificationToken.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  return result.count;
}

export function startPeriodicCleanup(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const sessions = await cleanupExpiredSessions();
      const tokens = await cleanupExpiredTokens();
      if (sessions > 0 || tokens > 0) {
        console.log(`Cleanup: removed ${sessions} expired sessions, ${tokens} expired tokens`);
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }, CLEANUP_INTERVAL_MS);
}
