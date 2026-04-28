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
    session: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '../lib/db';

const mockedPrisma = vi.mocked(prisma);

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 if no session cookie is present', async () => {
    const res = await request(app).post('/api/auth/logout');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 if session does not exist in database', async () => {
    mockedPrisma.session.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'session_id=invalid-session-id');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('deletes the session and clears cookie on valid logout', async () => {
    const mockSession = {
      id: 'session-123',
      userId: 'user-123',
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      user: {
        id: 'user-123',
        email: 'test@example.com',
        emailVerified: true,
        passwordHash: 'hashed',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockedPrisma.session.findUnique.mockResolvedValue(mockSession);
    mockedPrisma.session.delete.mockResolvedValue(mockSession);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'session_id=session-123');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Logged out successfully');
    expect(mockedPrisma.session.delete).toHaveBeenCalledWith({
      where: { id: 'session-123' },
    });
    // Check that the cookie is cleared (Express sets Expires to epoch)
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies[0]).toContain('session_id=');
    expect(cookies[0]).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('does not affect other sessions for the same user', async () => {
    const mockSession = {
      id: 'session-123',
      userId: 'user-123',
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      user: {
        id: 'user-123',
        email: 'test@example.com',
        emailVerified: true,
        passwordHash: 'hashed',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    mockedPrisma.session.findUnique.mockResolvedValue(mockSession);
    mockedPrisma.session.delete.mockResolvedValue(mockSession);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'session_id=session-123');

    expect(res.status).toBe(200);
    // Only deletes the specific session, not deleteMany
    expect(mockedPrisma.session.delete).toHaveBeenCalledWith({
      where: { id: 'session-123' },
    });
    expect(mockedPrisma.session.delete).toHaveBeenCalledTimes(1);
  });
});
