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

// Mock the db module
vi.mock('../lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    verificationToken: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
  },
}));

vi.mock('../services/email', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('crypto', () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue('mock-verification-token'),
  }),
}));

import { prisma } from '../lib/db';
import { sendVerificationEmail } from '../services/email';

const mockedPrisma = vi.mocked(prisma);
const mockedSendVerificationEmail = vi.mocked(sendVerificationEmail);

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if email is missing', async () => {
    const res = await request(app).post('/api/auth/register').send({ password: 'Valid1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 if email is invalid', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'invalid', password: 'ValidPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('email');
  });

  it('returns 400 if password is too weak', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'user@example.com', password: 'weak' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 409 if email is already registered', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: '1',
      email: 'existing@example.com',
      passwordHash: 'hash',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'existing@example.com', password: 'ValidPass1!' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('email');
  });

  it('creates user and returns 201 on valid input', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({
      id: 'uuid-123',
      email: 'new@example.com',
      passwordHash: 'hashed_password',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'uuid-123',
      token: 'mock-verification-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: 'ValidPass1!' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBeDefined();
  });

  it('generates verification token and sends email after user creation', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({
      id: 'uuid-123',
      email: 'new@example.com',
      passwordHash: 'hashed_password',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'uuid-123',
      token: 'mock-verification-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: 'ValidPass1!' });

    expect(mockedPrisma.verificationToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'uuid-123',
        type: 'EMAIL_VERIFICATION',
      }),
    });
    expect(mockedSendVerificationEmail).toHaveBeenCalledWith({
      email: 'new@example.com',
      token: 'mock-verification-token',
    });
  });

  it('stores email in lowercase', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({
      id: 'uuid-123',
      email: 'user@example.com',
      passwordHash: 'hashed_password',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'uuid-123',
      token: 'mock-verification-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await request(app)
      .post('/api/auth/register')
      .send({ email: 'User@Example.COM', password: 'ValidPass1!' });

    expect(mockedPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'user@example.com' }),
      }),
    );
  });

  it('hashes the password with bcrypt cost 12', async () => {
    const bcrypt = await import('bcrypt');
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.user.create.mockResolvedValue({
      id: 'uuid-123',
      email: 'user@example.com',
      passwordHash: 'hashed_password',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedPrisma.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.verificationToken.create.mockResolvedValue({
      id: 'token-id',
      userId: 'uuid-123',
      token: 'mock-verification-token',
      type: 'EMAIL_VERIFICATION',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await request(app)
      .post('/api/auth/register')
      .send({ email: 'user@example.com', password: 'ValidPass1!' });

    expect(bcrypt.default.hash).toHaveBeenCalledWith('ValidPass1!', 12);
  });
});
