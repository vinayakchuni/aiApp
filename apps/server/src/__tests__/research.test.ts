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

vi.mock('../services/search', () => ({
  createSearchService: vi.fn(),
  getMaxSearchesPerResearch: vi.fn(() => 20),
  SearchBudgetExhaustedError: class extends Error {
    constructor() {
      super('budget');
      this.name = 'SearchBudgetExhaustedError';
    }
  },
  SearchProviderError: class extends Error {
    public readonly providersTried: readonly string[];
    constructor(message: string, providersTried: readonly string[] = []) {
      super(message);
      this.name = 'SearchProviderError';
      this.providersTried = providersTried;
    }
  },
}));

import { prisma } from '../lib/db';
import { generateAssistantText } from '../services/ai';
import {
  parseClarifyingQuestions,
  parseProcessAnswerResponse,
  parseSearchQueries,
  parseRequestedFiles,
  matchRequestedFiles,
  runResearchPipeline,
} from '../services/research';
import { createSearchService, SearchProviderError } from '../services/search';

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

describe('parseSearchQueries', () => {
  it('parses one-per-line plain text', () => {
    expect(
      parseSearchQueries(`climate impacts agriculture
EU crop yields 2024
heat stress livestock`),
    ).toEqual([
      'climate impacts agriculture',
      'EU crop yields 2024',
      'heat stress livestock',
    ]);
  });

  it('strips numbering and quotes', () => {
    expect(
      parseSearchQueries(`1. "EU climate policy"
2) 'heat stress livestock'
- climate impacts agriculture`),
    ).toEqual(['EU climate policy', 'heat stress livestock', 'climate impacts agriculture']);
  });

  it('caps at 5 queries', () => {
    const text = Array.from({ length: 9 }, (_, i) => `q${i}`).join('\n');
    expect(parseSearchQueries(text)).toHaveLength(5);
  });

  it('ignores READ_FILE lines mixed in with queries', () => {
    expect(
      parseSearchQueries(`eu climate policy
READ_FILE: report.pdf
heat stress livestock`),
    ).toEqual(['eu climate policy', 'heat stress livestock']);
  });
});

describe('parseRequestedFiles + matchRequestedFiles', () => {
  it('extracts READ_FILE: <name> lines case-insensitively', () => {
    expect(
      parseRequestedFiles(`some queries
READ_FILE: alpha.pdf
read_file:beta.txt
nope.txt`),
    ).toEqual(['alpha.pdf', 'beta.txt']);
  });

  it('strips wrapping quotes', () => {
    expect(parseRequestedFiles('READ_FILE: "Quoted Doc.pdf"')).toEqual([
      'Quoted Doc.pdf',
    ]);
  });

  it('matches files by exact name then substring, never double-counting', () => {
    const files = [
      { id: '1', originalName: 'report.pdf', summary: null, extractedText: 'a' },
      { id: '2', originalName: 'notes.txt', summary: null, extractedText: 'b' },
    ];
    expect(matchRequestedFiles(['report.pdf', 'report.pdf'], files)).toHaveLength(1);
    expect(matchRequestedFiles(['report'], files)[0].id).toBe('1');
    expect(matchRequestedFiles(['missing.docx'], files)).toEqual([]);
  });
});

describe('runResearchPipeline', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
  });

  function setupConversation(opts: {
    mode?: 'chat' | 'research';
    status?: string;
    userId?: string;
  } = {}) {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: opts.userId ?? USER_ID,
      mode: opts.mode ?? 'research',
      researchStatus: opts.status ?? 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
  }

  function setupHistory() {
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Climate impacts on agriculture', metadata: null },
      {
        role: 'assistant',
        content: '1. Region?\n2. Time horizon?',
        metadata: { kind: 'clarifying_questions', questions: ['Region?', 'Time horizon?'] },
      },
      { role: 'user', content: 'EU only, next 5 years', metadata: null },
      {
        role: 'assistant',
        content: 'READY: focus on EU agricultural impacts through 2030.',
        metadata: { kind: 'research_ready', summary: 'focus on EU through 2030' },
      },
    ] as never);
  }

  it('returns not-found for the wrong user', async () => {
    setupConversation({ userId: OTHER_USER_ID });
    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out).toEqual({ kind: 'not-found' });
  });

  it('returns wrong-status when status is not researching', async () => {
    setupConversation({ status: 'clarifying' });
    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out).toEqual({ kind: 'wrong-status' });
  });

  it('runs the happy path: plans queries, gathers sources, writes draft, marks complete', async () => {
    setupConversation();
    setupHistory();

    mockedGenerate
      .mockResolvedValueOnce('eu agriculture climate impacts\nheat stress crops eu')
      .mockResolvedValueOnce('Draft body with citations [1] [2] [3].');

    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { title: 'A', url: 'https://a.example', snippet: 'sa' },
          { title: 'B', url: 'https://b.example', snippet: 'sb' },
        ])
        .mockResolvedValueOnce([
          { title: 'B-dup', url: 'https://b.example', snippet: 'sb2' },
          { title: 'C', url: 'https://c.example', snippet: 'sc' },
        ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);

    mockedPrisma.message.create.mockResolvedValue({
      id: 'm-draft',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Draft body with citations [1] [2] [3].',
      createdAt: new Date(),
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'New conversation',
      mode: 'research',
      researchStatus: 'complete',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const progressEvents: { stage: string; detail?: string }[] = [];
    const out = await runResearchPipeline({
      userId: USER_ID,
      conversationId: 'conv-1',
      onProgress: (p) => progressEvents.push(p),
    });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      // De-duplicated by URL
      expect(out.sources.map((s) => s.url)).toEqual([
        'https://a.example',
        'https://b.example',
        'https://c.example',
      ]);
      expect(out.queries).toEqual([
        'eu agriculture climate impacts',
        'heat stress crops eu',
      ]);
    }

    // Persisted with metadata
    const draftCreate = mockedPrisma.message.create.mock.calls[0][0] as {
      data: { metadata: { kind: string; queries: string[]; sources: unknown[] } };
    };
    expect(draftCreate.data.metadata.kind).toBe('research_draft');
    expect(draftCreate.data.metadata.queries).toEqual([
      'eu agriculture climate impacts',
      'heat stress crops eu',
    ]);
    expect(draftCreate.data.metadata.sources).toHaveLength(3);

    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'complete', updatedAt: expect.any(Date) },
    });

    // Progress events covered all stages in order
    const stages = progressEvents.map((p) => p.stage);
    expect(stages).toEqual([
      'generating_queries',
      'searching',
      'searching',
      'analyzing_sources',
      'writing_draft',
    ]);
  });

  it('returns insufficient-sources and marks failed when <3 unique sources gathered', async () => {
    setupConversation();
    setupHistory();
    mockedGenerate.mockResolvedValueOnce('q1\nq2');
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { title: 'A', url: 'https://a.example', snippet: 'sa' },
        ])
        .mockResolvedValueOnce([
          { title: 'A-dup', url: 'https://a.example', snippet: 'sa' },
          { title: 'B', url: 'https://b.example', snippet: 'sb' },
        ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.conversation.update.mockResolvedValue({} as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out).toEqual({ kind: 'insufficient-sources', sourcesFound: 2 });
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'failed', updatedAt: expect.any(Date) },
    });
    // Draft not persisted
    expect(mockedPrisma.message.create).not.toHaveBeenCalled();
    // Draft LLM call NOT made
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it('returns search-failed when every query errors at the provider layer', async () => {
    setupConversation();
    setupHistory();
    mockedGenerate.mockResolvedValueOnce('q1\nq2');
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi
        .fn()
        .mockRejectedValue(new SearchProviderError('boom', ['firecrawl', 'brave'])),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.conversation.update.mockResolvedValue({} as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('search-failed');
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'failed', updatedAt: expect.any(Date) },
    });
  });

  it('returns ai-error when query planning throws', async () => {
    setupConversation();
    setupHistory();
    mockedGenerate.mockRejectedValueOnce(new Error('llm down'));
    mockedPrisma.conversation.update.mockResolvedValue({} as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ai-error');
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'failed', updatedAt: expect.any(Date) },
    });
  });

  it('injects file summaries into planning and full text into draft when LLM requests READ_FILE', async () => {
    setupConversation();
    setupHistory();
    mockedPrisma.file.findMany.mockResolvedValue([
      {
        id: 'f-1',
        originalName: 'climate-report.pdf',
        summary: 'Authoritative summary of EU climate impacts.',
        extractedText: 'FULL TEXT OF THE CLIMATE REPORT',
      },
      {
        id: 'f-2',
        originalName: 'misc.txt',
        summary: 'Tangentially related notes.',
        extractedText: 'FULL TEXT OF MISC',
      },
    ] as never);

    mockedGenerate
      .mockResolvedValueOnce(
        'eu climate policy\nheat stress crops\nREAD_FILE: climate-report.pdf',
      )
      .mockResolvedValueOnce('Draft body with citations [1] [2] [3].');

    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
        { title: 'B', url: 'https://b.example', snippet: 'sb' },
        { title: 'C', url: 'https://c.example', snippet: 'sc' },
      ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);

    mockedPrisma.message.create.mockResolvedValue({
      id: 'm-draft',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Draft body with citations [1] [2] [3].',
      createdAt: new Date(),
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'New conversation',
      mode: 'research',
      researchStatus: 'complete',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const out = await runResearchPipeline({
      userId: USER_ID,
      conversationId: 'conv-1',
    });
    expect(out.kind).toBe('ok');

    // Planning prompt contained both summaries
    const planningCall = mockedGenerate.mock.calls[0];
    const planningPrompt = (planningCall[0] as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(planningPrompt).toContain('Authoritative summary of EU climate impacts.');
    expect(planningPrompt).toContain('Tangentially related notes.');

    // Draft prompt contained the requested file's full text but NOT the other file's full text
    const draftCall = mockedGenerate.mock.calls[1];
    const draftPrompt = (draftCall[0] as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(draftPrompt).toContain('FULL TEXT OF THE CLIMATE REPORT');
    expect(draftPrompt).not.toContain('FULL TEXT OF MISC');
    // Both summaries are still passed at the summary tier
    expect(draftPrompt).toContain('Authoritative summary of EU climate impacts.');
    expect(draftPrompt).toContain('Tangentially related notes.');

    // documents metadata reflects what was injected
    const draftCreate = mockedPrisma.message.create.mock.calls[0][0] as {
      data: {
        metadata: {
          kind: string;
          documents: { id: string; fullTextIncluded: boolean }[];
        };
      };
    };
    expect(draftCreate.data.metadata.kind).toBe('research_draft');
    expect(draftCreate.data.metadata.documents).toEqual([
      { id: 'f-1', originalName: 'climate-report.pdf', hadSummary: true, fullTextIncluded: true },
      { id: 'f-2', originalName: 'misc.txt', hadSummary: true, fullTextIncluded: false },
    ]);
  });

  it('returns ai-error when draft generation throws (after gathering sources)', async () => {
    setupConversation();
    setupHistory();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2\nq3')
      .mockRejectedValueOnce(new Error('llm draft fail'));
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
        { title: 'B', url: 'https://b.example', snippet: 'sb' },
        { title: 'C', url: 'https://c.example', snippet: 'sc' },
      ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.conversation.update.mockResolvedValue({} as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ai-error');
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'failed', updatedAt: expect.any(Date) },
    });
    expect(mockedPrisma.message.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/conversations/:id/research/run (SSE)', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
  });

  it('requires auth', async () => {
    const res = await request(app)
      .post('/api/conversations/conv-1/research/run')
      .send({});
    expect(res.status).toBe(401);
  });

  it('streams progress + complete events on the happy path', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Topic', metadata: null },
      {
        role: 'assistant',
        content: 'READY: scope',
        metadata: { kind: 'research_ready', summary: 'scope' },
      },
    ] as never);
    mockedGenerate.mockResolvedValueOnce('q1\nq2').mockResolvedValueOnce('Draft body.');
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
        { title: 'B', url: 'https://b.example', snippet: 'sb' },
        { title: 'C', url: 'https://c.example', snippet: 'sc' },
      ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.message.create.mockResolvedValue({
      id: 'm-draft',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Draft body.',
      createdAt: new Date(),
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Topic',
      mode: 'research',
      researchStatus: 'complete',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const res = await request(app)
      .post('/api/conversations/conv-1/research/run')
      .set('Cookie', 'session_id=session-1')
      .send({});

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const types = events.map((e) => e.event);
    expect(types).toContain('research-progress');
    expect(types[types.length - 1]).toBe('research-complete');
    const complete = events[events.length - 1].data as {
      conversation: { researchStatus: string };
      assistantMessage: { id: string };
    };
    expect(complete.conversation.researchStatus).toBe('complete');
    expect(complete.assistantMessage.id).toBe('m-draft');
  });

  it('emits research-failed when status is not researching', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'clarifying',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);

    const res = await request(app)
      .post('/api/conversations/conv-1/research/run')
      .set('Cookie', 'session_id=session-1')
      .send({});

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const failed = events.find((e) => e.event === 'research-failed');
    expect(failed).toBeDefined();
    expect((failed!.data as { code: string }).code).toBe('WRONG_STATUS');
  });

  it('emits research-failed with INSUFFICIENT_SOURCES when too few sources gathered', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Topic', metadata: null },
    ] as never);
    mockedGenerate.mockResolvedValueOnce('q1\nq2');
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
      ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.conversation.update.mockResolvedValue({} as never);

    const res = await request(app)
      .post('/api/conversations/conv-1/research/run')
      .set('Cookie', 'session_id=session-1')
      .send({});

    const events = parseSseEvents(res.text);
    const failed = events.find((e) => e.event === 'research-failed');
    expect(failed).toBeDefined();
    expect((failed!.data as { code: string }).code).toBe('INSUFFICIENT_SOURCES');
  });
});

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
