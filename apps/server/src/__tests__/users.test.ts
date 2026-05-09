import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

vi.mock('../middleware/csrf', () => ({
  csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  csrfTokenEndpoint: (_req: unknown, res: { json: (data: unknown) => void }) =>
    res.json({ csrfToken: 'test' }),
}));

vi.mock('../middleware/rate-limit', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  registerLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  forgotPasswordLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    session: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../lib/db';

const mockedPrisma = vi.mocked(prisma);
const USER_ID = 'user-1';

function authedSession() {
  const now = new Date();
  mockedPrisma.session.findUnique.mockResolvedValue({
    id: 'session-1',
    userId: USER_ID,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    createdAt: now,
    user: {
      id: USER_ID,
      email: 'user@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      passwordHash: 'hash',
    },
  } as never);
}

describe('User Settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Auth enforcement', () => {
    it('rejects GET /api/users/settings without session', async () => {
      const res = await request(app).get('/api/users/settings');
      expect(res.status).toBe(401);
    });

    it('rejects PATCH /api/users/settings without session', async () => {
      const res = await request(app)
        .patch('/api/users/settings')
        .send({ preferredModel: 'openai:gpt-4o-mini' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/users/settings', () => {
    it("returns the user's settings and the available model list", async () => {
      authedSession();
      mockedPrisma.user.findUnique.mockResolvedValue({
        preferredModel: 'openai:gpt-4o-mini',
        streamingEnabled: true,
      } as never);

      const res = await request(app)
        .get('/api/users/settings')
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.settings.preferredModel).toBe('openai:gpt-4o-mini');
      expect(res.body.settings.streamingEnabled).toBe(true);
      expect(Array.isArray(res.body.settings.models)).toBe(true);
      expect(res.body.settings.models.length).toBeGreaterThan(0);
      // model entries are { id, label } only — no provider internals
      for (const m of res.body.settings.models) {
        expect(typeof m.id).toBe('string');
        expect(typeof m.label).toBe('string');
        expect(m.provider).toBeUndefined();
      }
    });
  });

  describe('PATCH /api/users/settings', () => {
    it('updates the preferred model when the identifier is supported', async () => {
      authedSession();
      mockedPrisma.user.update.mockResolvedValue({
        preferredModel: 'anthropic:claude-3-5-sonnet-latest',
        streamingEnabled: true,
      } as never);

      const res = await request(app)
        .patch('/api/users/settings')
        .set('Cookie', 'session_id=session-1')
        .send({ preferredModel: 'anthropic:claude-3-5-sonnet-latest' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.settings.preferredModel).toBe('anthropic:claude-3-5-sonnet-latest');
      expect(mockedPrisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { preferredModel: 'anthropic:claude-3-5-sonnet-latest' },
        select: { preferredModel: true, streamingEnabled: true },
      });
    });

    it('updates streamingEnabled', async () => {
      authedSession();
      mockedPrisma.user.update.mockResolvedValue({
        preferredModel: 'openai:gpt-4o-mini',
        streamingEnabled: false,
      } as never);

      const res = await request(app)
        .patch('/api/users/settings')
        .set('Cookie', 'session_id=session-1')
        .send({ streamingEnabled: false });

      expect(res.status).toBe(200);
      expect(res.body.settings.streamingEnabled).toBe(false);
      expect(mockedPrisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { streamingEnabled: false },
        select: { preferredModel: true, streamingEnabled: true },
      });
    });

    it('rejects an unknown model identifier without writing to the DB', async () => {
      authedSession();

      const res = await request(app)
        .patch('/api/users/settings')
        .set('Cookie', 'session_id=session-1')
        .send({ preferredModel: 'openai:not-a-real-model' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/invalid model/i);
      expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects non-boolean streamingEnabled', async () => {
      authedSession();

      const res = await request(app)
        .patch('/api/users/settings')
        .set('Cookie', 'session_id=session-1')
        .send({ streamingEnabled: 'yes' });

      expect(res.status).toBe(400);
      expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    });

    it('returns 400 when no settings are provided', async () => {
      authedSession();

      const res = await request(app)
        .patch('/api/users/settings')
        .set('Cookie', 'session_id=session-1')
        .send({});

      expect(res.status).toBe(400);
      expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});
