import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

// Mock CSRF to passthrough
vi.mock('../middleware/csrf', () => ({
  csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  csrfTokenEndpoint: (_req: unknown, res: { json: (data: unknown) => void }) => res.json({ csrfToken: 'test' }),
}));

// Mock rate limiter to passthrough
vi.mock('../middleware/rate-limit', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  registerLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  forgotPasswordLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    verificationToken: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../services/email', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('crypto', () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue('mock-reset-token'),
  }),
}));

import { prisma } from '../lib/db';
import { sendPasswordResetEmail } from '../services/email';

const mockedPrisma = vi.mocked(prisma);
const mockedSendPasswordResetEmail = vi.mocked(sendPasswordResetEmail);

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if email is missing', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 if email is invalid', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns success even if user does not exist (prevents enumeration)', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nonexistent@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockedSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('generates token and sends reset email for existing user', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-123',
      email: 'user@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'user-123',
      token: 'mock-reset-token',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'user@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockedPrisma.verificationToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-123',
        type: 'PASSWORD_RESET',
      }),
    });
    expect(mockedSendPasswordResetEmail).toHaveBeenCalledWith({
      email: 'user@example.com',
      token: 'mock-reset-token',
    });
  });

  it('normalizes email to lowercase', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'User@Example.COM' });

    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'user@example.com' },
    });
  });
});
