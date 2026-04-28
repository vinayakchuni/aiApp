import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

vi.mock('../lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    verificationToken: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../services/email', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('crypto', () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue('mock-token-hex'),
  }),
}));

import { prisma } from '../lib/db';
import { sendVerificationEmail } from '../services/email';

const mockedPrisma = vi.mocked(prisma);
const mockedSendVerificationEmail = vi.mocked(sendVerificationEmail);

describe('GET /api/auth/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if token query param is missing', async () => {
    const res = await request(app).get('/api/auth/verify-email');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('token');
  });

  it('returns 400 if token is invalid or not found', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/auth/verify-email?token=bad-token');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('invalid');
  });

  it('returns 400 if token is expired', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'expired-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(Date.now() - 60000),
      createdAt: new Date(),
    });

    const res = await request(app).get('/api/auth/verify-email?token=expired-token');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('expired');
  });

  it('verifies user email, deletes token, and returns success', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'valid-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    mockedPrisma.user.update.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.verificationToken.delete.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'valid-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request(app).get('/api/auth/verify-email?token=valid-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { emailVerified: true },
    });
    expect(mockedPrisma.verificationToken.delete).toHaveBeenCalledWith({
      where: { id: 'token-id' },
    });
  });

  it('returns 400 if token type is not EMAIL_VERIFICATION', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'wrong-type-token',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });

    const res = await request(app).get('/api/auth/verify-email?token=wrong-type-token');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/auth/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if email is missing', async () => {
    const res = await request(app).post('/api/auth/resend-verification').send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns success even if user not found (prevents enumeration)', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'noone@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockedSendVerificationEmail).not.toHaveBeenCalled();
  });

  it('returns success if user is already verified (no email sent)', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'user@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockedSendVerificationEmail).not.toHaveBeenCalled();
  });

  it('generates a new token and sends verification email for unverified user', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hash',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'user-1',
      token: 'mock-token-hex',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'user@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockedSendVerificationEmail).toHaveBeenCalledWith({
      email: 'user@example.com',
      token: 'mock-token-hex',
    });
  });
});
