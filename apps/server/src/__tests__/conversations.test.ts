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
    message: { create: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../services/ai', () => ({
  defaultModel: vi.fn(() => 'mock-model'),
  streamAssistantText: vi.fn(),
  generateAssistantText: vi.fn(),
}));

import { prisma } from '../lib/db';
import { streamAssistantText, generateAssistantText } from '../services/ai';

const mockedPrisma = vi.mocked(prisma);
const mockedStream = vi.mocked(streamAssistantText);
const mockedGenerate = vi.mocked(generateAssistantText);
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

function chunksOf(...chunks: string[]) {
  return {
    textStream: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

function parseSseEvents(body: string) {
  const events: { event: string; data: unknown }[] = [];
  for (const block of body.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    events.push({ event, data: JSON.parse(dataLines.join('\n')) });
  }
  return events;
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

    describe('non-streaming (?stream=false)', () => {
      it('persists user message, calls generateAssistantText with full history, and returns JSON', async () => {
        authedSession();
        const now = new Date();
        mockedPrisma.conversation.findUnique.mockResolvedValue({
          id: 'conv-1',
          userId: USER_ID,
        } as never);
        const userMsg = {
          id: 'm-user',
          conversationId: 'conv-1',
          role: 'user',
          content: 'hello',
          createdAt: now,
        };
        const assistantMsg = {
          id: 'm-asst',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Hi there!',
          createdAt: now,
        };
        mockedPrisma.message.create
          .mockResolvedValueOnce(userMsg as never)
          .mockResolvedValueOnce(assistantMsg as never);
        mockedPrisma.message.findMany.mockResolvedValue([
          { role: 'user', content: 'hello' },
        ] as never);
        mockedPrisma.conversation.update.mockResolvedValue({} as never);
        mockedGenerate.mockResolvedValue('Hi there!');

        const res = await request(app)
          .post('/api/conversations/conv-1/messages?stream=false')
          .set('Cookie', 'session_id=session-1')
          .send({ content: 'hello' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.userMessage.id).toBe('m-user');
        expect(res.body.assistantMessage.id).toBe('m-asst');
        expect(res.body.assistantMessage.content).toBe('Hi there!');
        expect(mockedGenerate).toHaveBeenCalledWith([
          { role: 'system', content: expect.any(String) },
          { role: 'user', content: 'hello' },
        ]);
        expect(mockedStream).not.toHaveBeenCalled();
        expect(mockedPrisma.message.create).toHaveBeenCalledTimes(2);
      });

      it('returns 502 if the AI provider throws', async () => {
        authedSession();
        const now = new Date();
        mockedPrisma.conversation.findUnique.mockResolvedValue({
          id: 'conv-1',
          userId: USER_ID,
        } as never);
        mockedPrisma.message.create.mockResolvedValueOnce({
          id: 'm-user',
          conversationId: 'conv-1',
          role: 'user',
          content: 'hello',
          createdAt: now,
        } as never);
        mockedPrisma.message.findMany.mockResolvedValue([
          { role: 'user', content: 'hello' },
        ] as never);
        mockedGenerate.mockRejectedValue(new Error('rate limited'));

        const res = await request(app)
          .post('/api/conversations/conv-1/messages?stream=false')
          .set('Cookie', 'session_id=session-1')
          .send({ content: 'hello' });

        expect(res.status).toBe(502);
        // user message is persisted, assistant is not
        expect(mockedPrisma.message.create).toHaveBeenCalledTimes(1);
      });
    });

    describe('streaming (default)', () => {
      it('streams chunks via SSE and persists assistant message on done', async () => {
        authedSession();
        const now = new Date();
        mockedPrisma.conversation.findUnique.mockResolvedValue({
          id: 'conv-1',
          userId: USER_ID,
        } as never);
        const userMsg = {
          id: 'm-user',
          conversationId: 'conv-1',
          role: 'user',
          content: 'hello',
          createdAt: now,
        };
        const assistantMsg = {
          id: 'm-asst',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Hi there!',
          createdAt: now,
        };
        mockedPrisma.message.create
          .mockResolvedValueOnce(userMsg as never)
          .mockResolvedValueOnce(assistantMsg as never);
        mockedPrisma.message.findMany.mockResolvedValue([
          { role: 'user', content: 'hello' },
        ] as never);
        mockedPrisma.conversation.update.mockResolvedValue({} as never);
        mockedStream.mockReturnValue(chunksOf('Hi ', 'there!'));

        const res = await request(app)
          .post('/api/conversations/conv-1/messages')
          .set('Cookie', 'session_id=session-1')
          .send({ content: 'hello' });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        const events = parseSseEvents(res.text);
        const types = events.map((e) => e.event);
        expect(types).toEqual(['user-message', 'chunk', 'chunk', 'done']);

        const userEvt = events[0].data as { userMessage: { id: string } };
        expect(userEvt.userMessage.id).toBe('m-user');

        const chunkTexts = events
          .filter((e) => e.event === 'chunk')
          .map((e) => (e.data as { text: string }).text);
        expect(chunkTexts.join('')).toBe('Hi there!');

        const doneEvt = events[3].data as { assistantMessage: { content: string } };
        expect(doneEvt.assistantMessage.content).toBe('Hi there!');

        // assistant message persisted with the concatenated stream text
        expect(mockedPrisma.message.create).toHaveBeenNthCalledWith(2, {
          data: { conversationId: 'conv-1', role: 'assistant', content: 'Hi there!' },
        });
      });

      it('emits an SSE error event when the AI stream fails and does not persist assistant message', async () => {
        authedSession();
        const now = new Date();
        mockedPrisma.conversation.findUnique.mockResolvedValue({
          id: 'conv-1',
          userId: USER_ID,
        } as never);
        mockedPrisma.message.create.mockResolvedValueOnce({
          id: 'm-user',
          conversationId: 'conv-1',
          role: 'user',
          content: 'hello',
          createdAt: now,
        } as never);
        mockedPrisma.message.findMany.mockResolvedValue([
          { role: 'user', content: 'hello' },
        ] as never);
        mockedStream.mockReturnValue({
          textStream: (async function* () {
            yield 'Hi ';
            throw new Error('boom');
          })(),
        });

        const res = await request(app)
          .post('/api/conversations/conv-1/messages')
          .set('Cookie', 'session_id=session-1')
          .send({ content: 'hello' });

        expect(res.headers['content-type']).toContain('text/event-stream');
        const events = parseSseEvents(res.text);
        const types = events.map((e) => e.event);
        expect(types).toContain('error');
        expect(types).not.toContain('done');
        // only the user message was persisted
        expect(mockedPrisma.message.create).toHaveBeenCalledTimes(1);
      });

      it('passes prior history to the model so context is preserved', async () => {
        authedSession();
        const now = new Date();
        mockedPrisma.conversation.findUnique.mockResolvedValue({
          id: 'conv-1',
          userId: USER_ID,
        } as never);
        mockedPrisma.message.create
          .mockResolvedValueOnce({
            id: 'm-user-2',
            conversationId: 'conv-1',
            role: 'user',
            content: 'and again',
            createdAt: now,
          } as never)
          .mockResolvedValueOnce({
            id: 'm-asst-2',
            conversationId: 'conv-1',
            role: 'assistant',
            content: 'ok',
            createdAt: now,
          } as never);
        mockedPrisma.message.findMany.mockResolvedValue([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'and again' },
        ] as never);
        mockedPrisma.conversation.update.mockResolvedValue({} as never);
        mockedStream.mockReturnValue(chunksOf('ok'));

        await request(app)
          .post('/api/conversations/conv-1/messages')
          .set('Cookie', 'session_id=session-1')
          .send({ content: 'and again' });

        expect(mockedStream).toHaveBeenCalledTimes(1);
        const passed = mockedStream.mock.calls[0][0];
        // system + 3 history messages (latest user already persisted before ctx build)
        expect(passed).toHaveLength(4);
        expect(passed[0].role).toBe('system');
        expect(passed.slice(1)).toEqual([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'and again' },
        ]);
      });
    });
  });
});
