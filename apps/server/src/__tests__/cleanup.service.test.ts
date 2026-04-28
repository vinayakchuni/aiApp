import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db', () => ({
  prisma: {
    session: {
      deleteMany: vi.fn(),
    },
    verificationToken: {
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from '../lib/db';
import { cleanupExpiredSessions, cleanupExpiredTokens } from '../services/cleanup';

const mockedPrisma = vi.mocked(prisma);

describe('cleanup service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cleanupExpiredSessions', () => {
    it('deletes sessions where expiresAt is in the past', async () => {
      mockedPrisma.session.deleteMany.mockResolvedValue({ count: 5 });

      const result = await cleanupExpiredSessions();

      expect(mockedPrisma.session.deleteMany).toHaveBeenCalledWith({
        where: {
          expiresAt: { lt: expect.any(Date) },
        },
      });
      expect(result).toBe(5);
    });
  });

  describe('cleanupExpiredTokens', () => {
    it('deletes tokens where expiresAt is in the past', async () => {
      mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 3 });

      const result = await cleanupExpiredTokens();

      expect(mockedPrisma.verificationToken.deleteMany).toHaveBeenCalledWith({
        where: {
          expiresAt: { lt: expect.any(Date) },
        },
      });
      expect(result).toBe(3);
    });
  });
});
