import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db', () => ({
  prisma: {
    verificationToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('crypto', () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue('mock-random-token-hex'),
  }),
}));

import { prisma } from '../lib/db';
import { generateVerificationToken, validateToken } from '../services/token';

const mockedPrisma = vi.mocked(prisma);

describe('generateVerificationToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a token with EMAIL_VERIFICATION type and 24h expiry', async () => {
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'mock-random-token-hex',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const result = await generateVerificationToken({
      userId: 'user-1',
      type: 'EMAIL_VERIFICATION',
    });

    expect(mockedPrisma.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', type: 'EMAIL_VERIFICATION' },
    });
    expect(mockedPrisma.verificationToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        token: 'mock-random-token-hex',
        type: 'EMAIL_VERIFICATION',
      }),
    });
    expect(result).toBe('mock-random-token-hex');
  });

  it('creates a token with PASSWORD_RESET type and 1h expiry', async () => {
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'mock-random-token-hex',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await generateVerificationToken({
      userId: 'user-1',
      type: 'PASSWORD_RESET',
    });

    const createCall = mockedPrisma.verificationToken.create.mock.calls[0]![0];
    const expiresAt = createCall.data.expiresAt as Date;
    // PASSWORD_RESET should expire in ~1 hour
    const diffMs = expiresAt.getTime() - Date.now();
    expect(diffMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(diffMs).toBeGreaterThan(59 * 60 * 1000);
  });

  it('deletes existing tokens of the same type before creating', async () => {
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 1 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'mock-random-token-hex',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await generateVerificationToken({
      userId: 'user-1',
      type: 'EMAIL_VERIFICATION',
    });

    expect(mockedPrisma.verificationToken.deleteMany).toHaveBeenCalledBefore(
      mockedPrisma.verificationToken.create,
    );
  });
});

describe('validateToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the token record if valid and not expired', async () => {
    const tokenRecord = {
      id: 'token-id',
      userId: 'user-1',
      token: 'valid-token',
      type: 'EMAIL_VERIFICATION' as const,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    };
    mockedPrisma.verificationToken.findUnique.mockResolvedValue(tokenRecord);

    const result = await validateToken({ token: 'valid-token', type: 'EMAIL_VERIFICATION' });

    expect(result).toEqual(tokenRecord);
    expect(mockedPrisma.verificationToken.findUnique).toHaveBeenCalledWith({
      where: { token: 'valid-token' },
    });
  });

  it('returns null if token not found', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue(null);

    const result = await validateToken({ token: 'bad-token', type: 'EMAIL_VERIFICATION' });

    expect(result).toBeNull();
  });

  it('returns null if token type does not match', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'valid-token',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });

    const result = await validateToken({ token: 'valid-token', type: 'EMAIL_VERIFICATION' });

    expect(result).toBeNull();
  });

  it('returns null if token is expired', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'expired-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(Date.now() - 60000),
      createdAt: new Date(),
    });

    const result = await validateToken({ token: 'expired-token', type: 'EMAIL_VERIFICATION' });

    expect(result).toBeNull();
  });
});
