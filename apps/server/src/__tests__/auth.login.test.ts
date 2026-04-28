import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

// Mock the db module
vi.mock('../lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    session: {
      create: vi.fn(),
    },
  },
}));

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
    compare: vi.fn(),
  },
}));

import { prisma } from '../lib/db';
import bcrypt from 'bcrypt';

const mockedPrisma = vi.mocked(prisma);
const mockedBcrypt = vi.mocked(bcrypt);

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'ValidPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 if password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 with generic message if user not found', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'noone@example.com', password: 'ValidPass1!' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('returns 401 with generic message if password is wrong', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedBcrypt.compare.mockResolvedValue(false as never);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'WrongPass1!' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('returns 403 if user email is not verified', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hashed',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockedBcrypt.compare.mockResolvedValue(true as never);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'ValidPass1!' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('verify');
  });

  it('creates session and sets cookie on successful login', async () => {
    const now = new Date();
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    mockedBcrypt.compare.mockResolvedValue(true as never);
    mockedPrisma.session.create.mockResolvedValue({
      id: 'session-123',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: now,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'ValidPass1!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('user@example.com');
    expect(res.body.user.id).toBe('user-1');
    // Check cookie is set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies[0]).toContain('session_id');
    expect(cookies[0]).toContain('HttpOnly');
  });

  it('normalizes email to lowercase before lookup', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'User@Example.COM', password: 'ValidPass1!' });

    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'user@example.com' },
      }),
    );
  });
});
