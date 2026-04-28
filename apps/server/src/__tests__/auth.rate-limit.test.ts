import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

// Mock CSRF to passthrough
vi.mock('../middleware/csrf', () => ({
  csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  csrfTokenEndpoint: (_req: unknown, res: { json: (data: unknown) => void }) => res.json({ csrfToken: 'test' }),
}));

// Mock the db module
vi.mock('../lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    session: {
      create: vi.fn(),
    },
    verificationToken: {
      create: vi.fn(),
    },
  },
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
    compare: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../services/token', () => ({
  generateVerificationToken: vi.fn().mockResolvedValue('mock-token'),
  validateToken: vi.fn(),
  consumeToken: vi.fn(),
}));

vi.mock('../services/email', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../lib/db';

const mockedPrisma = vi.mocked(prisma);

describe('Auth route rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue(null);
  });

  it('rate limits login after 5 attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com', password: 'WrongPass1!' });
    }

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'WrongPass1!' });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Too many requests');
  });

  it('rate limits registration after 3 attempts', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/auth/register')
        .send({ email: `user${i}@example.com`, password: 'ValidPass1!' });
    }

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'another@example.com', password: 'ValidPass1!' });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Too many requests');
  });

  it('rate limits forgot-password after 3 attempts', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'test@example.com' });
    }

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Too many requests');
  });
});
