import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

// Mock the db module
vi.mock('../lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
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

import { prisma } from '../lib/db';

const mockedPrisma = vi.mocked(prisma);

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

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: 'ValidPass1!' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBeDefined();
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

    await request(app)
      .post('/api/auth/register')
      .send({ email: 'user@example.com', password: 'ValidPass1!' });

    expect(bcrypt.default.hash).toHaveBeenCalledWith('ValidPass1!', 12);
  });
});
