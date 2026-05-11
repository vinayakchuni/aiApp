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
    user: { findUnique: vi.fn() },
    session: { findUnique: vi.fn(), create: vi.fn() },
    conversation: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    message: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    file: { findMany: vi.fn() },
  },
}));

vi.mock('../services/ai', () => ({
  defaultModel: vi.fn(() => 'mock-model'),
  streamAssistantText: vi.fn(),
  generateAssistantText: vi.fn(),
}));

import { prisma } from '../lib/db';
import { generateAssistantText } from '../services/ai';
import {
  parseClarifyingQuestions,
  parseProcessAnswerResponse,
} from '../services/research';

const mockedPrisma = vi.mocked(prisma);
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

describe('Research service parsers', () => {
  describe('parseClarifyingQuestions', () => {
    it('parses a numbered list', () => {
      const text = `1. What is your scope?
2. How deep should the analysis go?
3. Who is the audience?`;
      expect(parseClarifyingQuestions(text)).toEqual([
        'What is your scope?',
        'How deep should the analysis go?',
        'Who is the audience?',
      ]);
    });

    it('parses a bullet list', () => {
      const text = `- Scope?\n* Audience?\n• Depth?`;
      expect(parseClarifyingQuestions(text)).toEqual(['Scope?', 'Audience?', 'Depth?']);
    });

    it('falls back to raw lines when no markers are present', () => {
      const text = 'Just one question here';
      expect(parseClarifyingQuestions(text)).toEqual(['Just one question here']);
    });
  });

  describe('parseProcessAnswerResponse', () => {
    it('detects READY: prefix and extracts summary', () => {
      const out = parseProcessAnswerResponse('READY: focus on EU policy through 2025.');
      expect(out.ready).toBe(true);
      expect(out.summary).toBe('focus on EU policy through 2025.');
      expect(out.questions).toEqual([]);
    });

    it('parses follow-up QUESTIONS list when not ready', () => {
      const out = parseProcessAnswerResponse(
        'QUESTIONS:\n1. Which region?\n2. Time horizon?\n3. Audience?',
      );
      expect(out.ready).toBe(false);
      expect(out.questions).toEqual(['Which region?', 'Time horizon?', 'Audience?']);
    });

    it('treats arbitrary non-READY responses as questions', () => {
      const out = parseProcessAnswerResponse('1. q1\n2. q2');
      expect(out.ready).toBe(false);
      expect(out.questions).toEqual(['q1', 'q2']);
    });
  });
});

describe('PATCH /api/conversations/:id mode toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects toggle when conversation already has messages', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'chat',
      _count: { messages: 3 },
    } as never);

    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .set('Cookie', 'session_id=session-1')
      .send({ mode: 'research' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONVERSATION_NOT_EMPTY');
    expect(mockedPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it('switches mode when the conversation is empty', async () => {
    authedSession();
    const now = new Date();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'chat',
      _count: { messages: 0 },
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'New conversation',
      mode: 'research',
      researchStatus: 'idle',
      createdAt: now,
      updatedAt: now,
    } as never);

    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .set('Cookie', 'session_id=session-1')
      .send({ mode: 'research' });

    expect(res.status).toBe(200);
    expect(res.body.conversation.mode).toBe('research');
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { mode: 'research', researchStatus: 'idle' },
    });
  });

  it('rejects an invalid mode value', async () => {
    authedSession();
    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .set('Cookie', 'session_id=session-1')
      .send({ mode: 'bogus' });
    expect(res.status).toBe(400);
  });

  it("returns 404 for another user's conversation", async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-x',
      userId: OTHER_USER_ID,
      mode: 'chat',
      _count: { messages: 0 },
    } as never);

    const res = await request(app)
      .patch('/api/conversations/conv-x')
      .set('Cookie', 'session_id=session-1')
      .send({ mode: 'research' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/conversations creates with mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a research conversation when mode=research is supplied', async () => {
    authedSession();
    const now = new Date();
    mockedPrisma.conversation.create.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'New conversation',
      mode: 'research',
      researchStatus: 'idle',
      createdAt: now,
      updatedAt: now,
    } as never);

    const res = await request(app)
      .post('/api/conversations')
      .set('Cookie', 'session_id=session-1')
      .send({ mode: 'research' });

    expect(res.status).toBe(201);
    expect(res.body.conversation.mode).toBe('research');
    expect(mockedPrisma.conversation.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, mode: 'research' },
    });
  });

  it('rejects an invalid mode at create time', async () => {
    authedSession();
    const res = await request(app)
      .post('/api/conversations')
      .set('Cookie', 'session_id=session-1')
      .send({ mode: 'invalid' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/conversations/:id/research', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects without session', async () => {
    const res = await request(app)
      .post('/api/conversations/conv-1/research')
      .send({ topic: 'AI safety' });
    expect(res.status).toBe(401);
  });

  it('rejects empty topic', async () => {
    authedSession();
    const res = await request(app)
      .post('/api/conversations/conv-1/research')
      .set('Cookie', 'session_id=session-1')
      .send({ topic: '   ' });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the conversation belongs to another user", async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-x',
      userId: OTHER_USER_ID,
      mode: 'research',
      researchStatus: 'idle',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);

    const res = await request(app)
      .post('/api/conversations/conv-x/research')
      .set('Cookie', 'session_id=session-1')
      .send({ topic: 'Quantum chemistry' });

    expect(res.status).toBe(404);
  });

  it('rejects when the conversation is not in research mode', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'chat',
      researchStatus: 'idle',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);

    const res = await request(app)
      .post('/api/conversations/conv-1/research')
      .set('Cookie', 'session_id=session-1')
      .send({ topic: 'Quantum chemistry' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_RESEARCH_MODE');
  });

  it('rejects when research has already been started', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'clarifying',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);

    const res = await request(app)
      .post('/api/conversations/conv-1/research')
      .set('Cookie', 'session_id=session-1')
      .send({ topic: 'Already started' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESEARCH_ALREADY_STARTED');
  });

  it('persists user message + clarifying-question assistant message and transitions to clarifying', async () => {
    authedSession();
    const now = new Date();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'idle',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
    mockedPrisma.message.create
      .mockResolvedValueOnce({
        id: 'm-user',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Climate impacts on agriculture',
        createdAt: now,
      } as never)
      .mockResolvedValueOnce({
        id: 'm-asst',
        conversationId: 'conv-1',
        role: 'assistant',
        content:
          '1. What region?\n2. Time horizon?\n3. Crops or livestock?\n4. Audience?',
        metadata: { kind: 'clarifying_questions' },
        createdAt: now,
      } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'New conversation',
      mode: 'research',
      researchStatus: 'clarifying',
      createdAt: now,
      updatedAt: now,
    } as never);

    mockedGenerate.mockResolvedValue(
      '1. What region?\n2. Time horizon?\n3. Crops or livestock?\n4. Audience?',
    );

    const res = await request(app)
      .post('/api/conversations/conv-1/research')
      .set('Cookie', 'session_id=session-1')
      .send({ topic: 'Climate impacts on agriculture' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.conversation.researchStatus).toBe('clarifying');
    expect(res.body.userMessage.id).toBe('m-user');
    expect(res.body.assistantMessage.id).toBe('m-asst');

    // Assistant message stored with metadata.kind === 'clarifying_questions'
    const assistantCreate = mockedPrisma.message.create.mock.calls[1][0] as {
      data: { metadata: { kind: string; questions: string[] } };
    };
    expect(assistantCreate.data.metadata.kind).toBe('clarifying_questions');
    expect(assistantCreate.data.metadata.questions).toEqual([
      'What region?',
      'Time horizon?',
      'Crops or livestock?',
      'Audience?',
    ]);

    // Status transitioned
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'clarifying', updatedAt: expect.any(Date) },
    });
  });

  it('returns 502 when the AI provider throws', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'idle',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
    mockedPrisma.message.create.mockResolvedValueOnce({
      id: 'm-user',
      conversationId: 'conv-1',
      role: 'user',
      content: 'Topic',
      createdAt: new Date(),
    } as never);
    mockedGenerate.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post('/api/conversations/conv-1/research')
      .set('Cookie', 'session_id=session-1')
      .send({ topic: 'Topic' });

    expect(res.status).toBe(502);
    // user message persisted, assistant not, no status change
    expect(mockedPrisma.message.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.conversation.update).not.toHaveBeenCalled();
  });
});

describe('Clarifying answer flow via POST /messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes clarifying-state messages to the research handler and stores another set of questions when not ready', async () => {
    authedSession();
    const now = new Date();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'clarifying',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
    mockedPrisma.message.create
      .mockResolvedValueOnce({
        id: 'm-user',
        conversationId: 'conv-1',
        role: 'user',
        content: 'EU only, next 5 years',
        createdAt: now,
      } as never)
      .mockResolvedValueOnce({
        id: 'm-asst',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'QUESTIONS:\n1. Crops? 2. Livestock?',
        createdAt: now,
      } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Climate' },
      { role: 'assistant', content: '1. Region?' },
      { role: 'user', content: 'EU only, next 5 years' },
    ] as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Climate',
      mode: 'research',
      researchStatus: 'clarifying',
      createdAt: now,
      updatedAt: now,
    } as never);
    mockedGenerate.mockResolvedValue('QUESTIONS:\n1. Crops?\n2. Livestock?');

    const res = await request(app)
      .post('/api/conversations/conv-1/messages')
      .set('Cookie', 'session_id=session-1')
      .send({ content: 'EU only, next 5 years' });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('questions');
    expect(res.body.conversation.researchStatus).toBe('clarifying');

    const assistantCreate = mockedPrisma.message.create.mock.calls[1][0] as {
      data: { metadata: { kind: string; questions: string[] } };
    };
    expect(assistantCreate.data.metadata.kind).toBe('clarifying_questions');
    expect(assistantCreate.data.metadata.questions).toEqual(['Crops?', 'Livestock?']);

    // status NOT bumped to researching
    const updateCall = mockedPrisma.conversation.update.mock.calls[0][0] as {
      data: { researchStatus?: string };
    };
    expect(updateCall.data.researchStatus).toBeUndefined();
  });

  it('transitions to researching when the LLM responds with READY:', async () => {
    authedSession();
    const now = new Date();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'clarifying',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
    mockedPrisma.message.create
      .mockResolvedValueOnce({
        id: 'm-user',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Looks good, please proceed.',
        createdAt: now,
      } as never)
      .mockResolvedValueOnce({
        id: 'm-asst',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'READY: focus on EU agricultural policy through 2030.',
        createdAt: now,
      } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Climate' },
      { role: 'assistant', content: '1. Region?' },
      { role: 'user', content: 'EU' },
      { role: 'assistant', content: '1. Crops?' },
      { role: 'user', content: 'Looks good, please proceed.' },
    ] as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Climate',
      mode: 'research',
      researchStatus: 'researching',
      createdAt: now,
      updatedAt: now,
    } as never);
    mockedGenerate.mockResolvedValue(
      'READY: focus on EU agricultural policy through 2030.',
    );

    const res = await request(app)
      .post('/api/conversations/conv-1/messages')
      .set('Cookie', 'session_id=session-1')
      .send({ content: 'Looks good, please proceed.' });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('ready');
    expect(res.body.conversation.researchStatus).toBe('researching');

    const assistantCreate = mockedPrisma.message.create.mock.calls[1][0] as {
      data: { metadata: { kind: string; summary?: string } };
    };
    expect(assistantCreate.data.metadata.kind).toBe('research_ready');
    expect(assistantCreate.data.metadata.summary).toBe(
      'focus on EU agricultural policy through 2030.',
    );

    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'researching', updatedAt: expect.any(Date) },
    });
  });

  it('rejects messages when research is in progress (status=researching)', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
    } as never);

    const res = await request(app)
      .post('/api/conversations/conv-1/messages')
      .set('Cookie', 'session_id=session-1')
      .send({ content: 'hi' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESEARCH_IN_PROGRESS');
    expect(mockedPrisma.message.create).not.toHaveBeenCalled();
  });
});
