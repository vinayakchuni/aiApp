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
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
    compare: vi.fn(),
  },
}));

import { prisma } from '../lib/db';

const mockedPrisma = vi.mocked(prisma);

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 if no session cookie is provided', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 if session does not exist in database', async () => {
    mockedPrisma.session.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'session_id=invalid-session-id');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 if session is expired', async () => {
    mockedPrisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000), // expired
      createdAt: new Date(),
    });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'session_id=session-1');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns current user if session is valid', async () => {
    const now = new Date();
    mockedPrisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour from now
      createdAt: now,
      user: {
        id: 'user-1',
        email: 'user@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        passwordHash: 'hash',
      },
    } as any);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'session_id=session-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.id).toBe('user-1');
    expect(res.body.user.email).toBe('user@example.com');
    expect(res.body.user.emailVerified).toBe(true);
    // Should not expose passwordHash
    expect(res.body.user.passwordHash).toBeUndefined();
  });
});
