import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

// Passthrough CSRF (mutations only)
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
    user: { findUnique: vi.fn() },
    session: { findUnique: vi.fn(), create: vi.fn() },
    conversation: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    message: { create: vi.fn() },
  },
}));

import { prisma } from '../lib/db';

const mockedPrisma = vi.mocked(prisma);
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

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

describe('Conversations API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Auth enforcement', () => {
    it('rejects POST /api/conversations without session', async () => {
      const res = await request(app).post('/api/conversations').send({});
      expect(res.status).toBe(401);
    });

    it('rejects GET /api/conversations without session', async () => {
      const res = await request(app).get('/api/conversations');
      expect(res.status).toBe(401);
    });

    it('rejects GET /api/conversations/:id without session', async () => {
      const res = await request(app).get('/api/conversations/some-id');
      expect(res.status).toBe(401);
    });

    it('rejects POST /api/conversations/:id/messages without session', async () => {
      const res = await request(app)
        .post('/api/conversations/some-id/messages')
        .send({ content: 'hi' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/conversations', () => {
    it('creates a conversation for the authenticated user', async () => {
      authedSession();
      const now = new Date();
      mockedPrisma.conversation.create.mockResolvedValue({
        id: 'conv-1',
        userId: USER_ID,
        title: 'New conversation',
        createdAt: now,
        updatedAt: now,
      } as never);

      const res = await request(app)
        .post('/api/conversations')
        .set('Cookie', 'session_id=session-1')
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.conversation.id).toBe('conv-1');
      expect(res.body.conversation.userId).toBe(USER_ID);
      expect(mockedPrisma.conversation.create).toHaveBeenCalledWith({
        data: { userId: USER_ID },
      });
    });

    it('passes title through when provided', async () => {
      authedSession();
      const now = new Date();
      mockedPrisma.conversation.create.mockResolvedValue({
        id: 'conv-1',
        userId: USER_ID,
        title: 'My chat',
        createdAt: now,
        updatedAt: now,
      } as never);

      await request(app)
        .post('/api/conversations')
        .set('Cookie', 'session_id=session-1')
        .send({ title: 'My chat' });

      expect(mockedPrisma.conversation.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, title: 'My chat' },
      });
    });
  });

  describe('GET /api/conversations', () => {
    it("returns the authenticated user's conversations ordered by updatedAt desc", async () => {
      authedSession();
      const now = new Date();
      mockedPrisma.conversation.findMany.mockResolvedValue([
        { id: 'conv-2', userId: USER_ID, title: 'Newer', createdAt: now, updatedAt: now },
        { id: 'conv-1', userId: USER_ID, title: 'Older', createdAt: now, updatedAt: now },
      ] as never);

      const res = await request(app)
        .get('/api/conversations')
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.conversations).toHaveLength(2);
      expect(mockedPrisma.conversation.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        orderBy: { updatedAt: 'desc' },
      });
    });
  });

  describe('GET /api/conversations/:id', () => {
    it('returns a conversation with messages', async () => {
      authedSession();
      const now = new Date();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: USER_ID,
        title: 'Chat',
        createdAt: now,
        updatedAt: now,
        messages: [
          { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'hi', createdAt: now },
          { id: 'm2', conversationId: 'conv-1', role: 'assistant', content: 'hi', createdAt: now },
        ],
      } as never);

      const res = await request(app)
        .get('/api/conversations/conv-1')
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.conversation.id).toBe('conv-1');
      expect(res.body.conversation.messages).toHaveLength(2);
    });

    it("returns 404 for another user's conversation", async () => {
      authedSession();
      const now = new Date();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-x',
        userId: OTHER_USER_ID,
        title: 'Chat',
        createdAt: now,
        updatedAt: now,
        messages: [],
      } as never);

      const res = await request(app)
        .get('/api/conversations/conv-x')
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(404);
    });

    it('returns 404 when conversation does not exist', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue(null as never);

      const res = await request(app)
        .get('/api/conversations/missing')
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/conversations/:id/messages', () => {
    it('saves user and echo assistant messages and returns both', async () => {
      authedSession();
      const now = new Date();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        userId: USER_ID,
      } as never);
      mockedPrisma.message.create
        .mockResolvedValueOnce({
          id: 'm1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'hello',
          createdAt: now,
        } as never)
        .mockResolvedValueOnce({
          id: 'm2',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'hello',
          createdAt: now,
        } as never);
      mockedPrisma.conversation.update.mockResolvedValue({} as never);

      const res = await request(app)
        .post('/api/conversations/conv-1/messages')
        .set('Cookie', 'session_id=session-1')
        .send({ content: 'hello' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.userMessage.role).toBe('user');
      expect(res.body.userMessage.content).toBe('hello');
      expect(res.body.assistantMessage.role).toBe('assistant');
      expect(res.body.assistantMessage.content).toBe('hello');
      expect(mockedPrisma.message.create).toHaveBeenCalledTimes(2);
    });

    it('returns 400 if content is missing or empty', async () => {
      authedSession();

      const res = await request(app)
        .post('/api/conversations/conv-1/messages')
        .set('Cookie', 'session_id=session-1')
        .send({ content: '   ' });

      expect(res.status).toBe(400);
      expect(mockedPrisma.message.create).not.toHaveBeenCalled();
    });

    it("returns 404 for another user's conversation", async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-x',
        userId: OTHER_USER_ID,
      } as never);

      const res = await request(app)
        .post('/api/conversations/conv-x/messages')
        .set('Cookie', 'session_id=session-1')
        .send({ content: 'hi' });

      expect(res.status).toBe(404);
      expect(mockedPrisma.message.create).not.toHaveBeenCalled();
    });
  });
});
