import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

vi.mock('../lib/db', () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
    },
    verificationToken: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('new_hashed_password'),
  },
}));

vi.mock('../services/email', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../lib/db';

const mockedPrisma = vi.mocked(prisma);

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if token is missing', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ password: 'NewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 if password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'some-token' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 if password is too weak', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'some-token', password: 'weak' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 if token is invalid', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'invalid-token', password: 'NewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('invalid');
  });

  it('returns 400 if token is expired', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-123',
      token: 'expired-token',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() - 1000), // expired
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'expired-token', password: 'NewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('expired');
  });

  it('resets password, deletes all sessions, and consumes token on valid request', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-123',
      token: 'valid-token',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 3600000), // valid
      createdAt: new Date(),
    });
    mockedPrisma.user.update.mockResolvedValue({
      id: 'user-123',
      email: 'user@example.com',
      passwordHash: 'new_hashed_password',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.session.deleteMany.mockResolvedValue({ count: 3 });
    mockedPrisma.verificationToken.delete.mockResolvedValue({
      id: 'token-id',
      userId: 'user-123',
      token: 'valid-token',
      type: 'PASSWORD_RESET',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'valid-token', password: 'NewPass1!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Password was hashed and updated
    const bcrypt = await import('bcrypt');
    expect(bcrypt.default.hash).toHaveBeenCalledWith('NewPass1!', 12);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: { passwordHash: 'new_hashed_password' },
    });

    // All sessions for the user were deleted
    expect(mockedPrisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-123' },
    });

    // Token was consumed
    expect(mockedPrisma.verificationToken.delete).toHaveBeenCalledWith({
      where: { id: 'token-id' },
    });
  });

  it('rejects token with wrong type', async () => {
    mockedPrisma.verificationToken.findUnique.mockResolvedValue({
      id: 'token-id',
      userId: 'user-123',
      token: 'email-token',
      type: 'EMAIL_VERIFICATION', // wrong type
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'email-token', password: 'NewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
