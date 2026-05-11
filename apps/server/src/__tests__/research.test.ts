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

vi.mock('../services/email', () => ({
  sendResearchCompleteEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  renderResearchReportHtml: vi.fn(() => '<html></html>'),
  renderResearchReportText: vi.fn(() => 'text'),
}));

const traceSpans: {
  name: string;
  startOpts?: unknown;
  updates: unknown[];
  endOpts?: unknown;
}[] = [];
const traceFinishes: unknown[] = [];
const traceMetadataUpdates: unknown[] = [];
const traceErrors: string[] = [];
const traceInits: unknown[] = [];

function clearTraceRecorder(): void {
  traceSpans.length = 0;
  traceFinishes.length = 0;
  traceMetadataUpdates.length = 0;
  traceErrors.length = 0;
  traceInits.length = 0;
}

vi.mock('../services/tracing', () => ({
  createResearchTrace: vi.fn((init: unknown) => {
    traceInits.push(init);
    return {
      isEnabled: true,
      startSpan: (name: string, opts: unknown) => {
        const record = { name, startOpts: opts, updates: [] as unknown[] };
        traceSpans.push(record);
        return {
          update: (body: unknown) => {
            record.updates.push(body);
          },
          end: (body: unknown) => {
            record.endOpts = body;
          },
        };
      },
      updateMetadata: (patch: unknown) => {
        traceMetadataUpdates.push(patch);
      },
      markError: (msg: string) => {
        traceErrors.push(msg);
      },
      finish: async (opts: unknown) => {
        traceFinishes.push(opts);
      },
    };
  }),
  getLangfuseClient: vi.fn(() => null),
  _resetLangfuseClient: vi.fn(),
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
import { sendResearchCompleteEmail } from '../services/email';
import {
  parseClarifyingQuestions,
  parseProcessAnswerResponse,
  parseSearchQueries,
  parseRequestedFiles,
  matchRequestedFiles,
  runResearchPipeline,
  parseCritique,
  weakestCriteria,
  allCriteriaPassed,
  draftSimilarity,
  parseClaims,
  factCheckDraft,
  countVerifiedClaims,
  parseStructuredReport,
  computeReportSources,
  computeReportMethodology,
  programmaticReportFromDraft,
  buildStructuredReport,
  getLatestResearchFinal,
  isResearchActiveForUser,
  _resetActiveResearch,
  _acquireActiveResearch,
} from '../services/research';
import {
  createSearchService,
  SearchBudgetExhaustedError,
  SearchProviderError,
} from '../services/search';

const PERFECT_CRITIQUE = `SCORES:
factual_accuracy: 5
completeness: 5
source_coverage: 5
coherence: 5
scope_alignment: 5

CRITIQUE:
Strong draft, nothing to improve.`;

const FAILING_CRITIQUE = `SCORES:
factual_accuracy: 4
completeness: 2
source_coverage: 3
coherence: 4
scope_alignment: 4

CRITIQUE:
Completeness is thin and source coverage is uneven.`;

const MOCK_REPORT = `EXECUTIVE_SUMMARY:
A concise overview of the findings.

KEY_FINDINGS:
- Finding one with citation [1].
- Finding two with citation [2].
- Finding three.

DETAILED_ANALYSIS:
A longer analysis paragraph synthesizing the supplied sources [1], [2], and [3].`;

const mockedPrisma = vi.mocked(prisma);
const mockedGenerate = vi.mocked(generateAssistantText);
const mockedSendResearchCompleteEmail = vi.mocked(sendResearchCompleteEmail);
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
      .mockResolvedValueOnce('Draft body with citations [1] [2] [3].')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

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
      data: {
        metadata: {
          kind: string;
          queries: string[];
          sources: unknown[];
          iterations: unknown[];
          exitReason: string;
        };
      };
    };
    expect(draftCreate.data.metadata.kind).toBe('research_final');
    expect(draftCreate.data.metadata.queries).toEqual([
      'eu agriculture climate impacts',
      'heat stress crops eu',
    ]);
    expect(draftCreate.data.metadata.sources).toHaveLength(3);
    // One critique iteration, all scores 5/5 → exit reason is all_passed, no revisions
    expect(draftCreate.data.metadata.iterations).toHaveLength(1);
    expect(draftCreate.data.metadata.exitReason).toBe('all_passed');

    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'complete', updatedAt: expect.any(Date) },
    });

    // Progress events covered all stages including the first critique round and finalizing
    const stages = progressEvents.map((p) => p.stage);
    expect(stages).toEqual([
      'generating_queries',
      'searching',
      'searching',
      'analyzing_sources',
      'writing_draft',
      'critiquing',
      'finalizing',
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
    mockedPrisma.message.create.mockResolvedValue({} as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out).toEqual({ kind: 'insufficient-sources', sourcesFound: 2 });
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'failed', updatedAt: expect.any(Date) },
    });
    // Only the research_failed message is persisted (no draft).
    const finalKinds = mockedPrisma.message.create.mock.calls.map((call) => {
      const data = (call[0] as { data?: { metadata?: { kind?: string } } }).data;
      return data?.metadata?.kind;
    });
    expect(finalKinds).toEqual(['research_failed']);
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
    mockedPrisma.message.create.mockResolvedValue({} as never);

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
    mockedPrisma.message.create.mockResolvedValue({} as never);

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
      .mockResolvedValueOnce('Draft body with citations [1] [2] [3].')
      .mockResolvedValueOnce(PERFECT_CRITIQUE);

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
    expect(draftCreate.data.metadata.kind).toBe('research_final');
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
    // A research_failed assistant message is persisted alongside the status flip,
    // but no research_final/research_draft message.
    const finalKinds = mockedPrisma.message.create.mock.calls.map((call) => {
      const data = (call[0] as { data?: { metadata?: { kind?: string } } }).data;
      return data?.metadata?.kind;
    });
    expect(finalKinds).not.toContain('research_final');
    expect(finalKinds).toContain('research_failed');
  });
});

describe('Critique parsing and helpers', () => {
  it('parseCritique extracts five scores and the critique body', () => {
    const out = parseCritique(`SCORES:
factual_accuracy: 4
completeness: 3
source_coverage: 5
coherence: 4
scope_alignment: 2

CRITIQUE:
Tighten the scope and broaden source diversity.`);
    expect(out).not.toBeNull();
    expect(out!.scores).toEqual({
      factual_accuracy: 4,
      completeness: 3,
      source_coverage: 5,
      coherence: 4,
      scope_alignment: 2,
    });
    expect(out!.critique).toBe('Tighten the scope and broaden source diversity.');
  });

  it('parseCritique returns null when a criterion is missing', () => {
    expect(
      parseCritique(`SCORES:
factual_accuracy: 4
completeness: 3
source_coverage: 5

CRITIQUE:
Body.`),
    ).toBeNull();
  });

  it('parseCritique clamps out-of-range scores into 1-5', () => {
    const out = parseCritique(`factual_accuracy: 9
completeness: 0
source_coverage: 3
coherence: 4
scope_alignment: 4
CRITIQUE: x`);
    expect(out!.scores.factual_accuracy).toBe(5);
    expect(out!.scores.completeness).toBe(1);
  });

  it('weakestCriteria flags scores under the threshold', () => {
    expect(
      weakestCriteria({
        factual_accuracy: 5,
        completeness: 3,
        source_coverage: 2,
        coherence: 4,
        scope_alignment: 4,
      }),
    ).toEqual(['completeness', 'source_coverage']);
  });

  it('allCriteriaPassed is true only when every score is >= 4', () => {
    expect(
      allCriteriaPassed({
        factual_accuracy: 4,
        completeness: 4,
        source_coverage: 4,
        coherence: 4,
        scope_alignment: 4,
      }),
    ).toBe(true);
    expect(
      allCriteriaPassed({
        factual_accuracy: 4,
        completeness: 4,
        source_coverage: 4,
        coherence: 4,
        scope_alignment: 3,
      }),
    ).toBe(false);
  });

  it('draftSimilarity is 1 for identical strings and < 1 for divergent ones', () => {
    expect(draftSimilarity('alpha beta gamma', 'alpha beta gamma')).toBe(1);
    expect(
      draftSimilarity('alpha beta gamma', 'completely different words entirely'),
    ).toBeLessThan(0.2);
  });
});

describe('Fact checker helpers', () => {
  it('parseClaims handles plain lines, dedupes, and caps to max', () => {
    expect(
      parseClaims(
        `EU CAP reform proposed in 2024.
- Crop yields dropped 12% in 2023.
"Heat stress livestock 2024"
EU CAP reform proposed in 2024.`,
        5,
      ),
    ).toEqual([
      'EU CAP reform proposed in 2024.',
      'Crop yields dropped 12% in 2023.',
      'Heat stress livestock 2024',
    ]);
  });

  it('parseClaims returns empty for NO_CLAIMS sentinel', () => {
    expect(parseClaims('NO_CLAIMS', 8)).toEqual([]);
    expect(parseClaims('  no_claims  ', 8)).toEqual([]);
    expect(parseClaims('', 8)).toEqual([]);
  });

  it('parseClaims caps at provided max', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Claim ${i}`).join('\n');
    expect(parseClaims(text, 3)).toEqual(['Claim 0', 'Claim 1', 'Claim 2']);
  });

  it('countVerifiedClaims counts only verified status', () => {
    expect(
      countVerifiedClaims({
        results: [
          { claim: 'a', status: 'verified', supportingUrls: ['x'] },
          { claim: 'b', status: 'unverified', supportingUrls: [] },
          { claim: 'c', status: 'verified', supportingUrls: ['y'] },
          { claim: 'd', status: 'not_checked', supportingUrls: [] },
        ],
        claimsExtracted: 4,
        searchesUsed: 3,
        budgetExhausted: false,
      }),
    ).toBe(2);
  });
});

describe('factCheckDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fakeSearchWith(impl: {
    remaining?: number;
    search?: ReturnType<typeof vi.fn>;
  }) {
    let rem = impl.remaining ?? 20;
    return {
      remaining: () => rem,
      search: impl.search ?? vi.fn().mockResolvedValue([]),
      _consume: () => {
        rem -= 1;
      },
    };
  }

  it('marks claims with hits as verified and empty results as unverified', async () => {
    const search = fakeSearchWith({
      remaining: 10,
      search: vi
        .fn()
        .mockImplementation(async (q: string) => {
          (search as { _consume: () => void })._consume();
          if (q.includes('A')) {
            return [
              { title: 'A1', url: 'https://a.example/1', snippet: 's1' },
              { title: 'A2', url: 'https://a.example/2', snippet: 's2' },
            ];
          }
          return [];
        }),
    });
    const generate = vi.fn().mockResolvedValue('Claim A.\nClaim B.');

    const out = await factCheckDraft({
      draft: 'irrelevant',
      maxClaims: 8,
      search: search as never,
      modelId: 'mock-model',
      generateFn: generate as never,
    });

    expect(out.llmCallsAttempted).toBe(1);
    expect(out.summary.claimsExtracted).toBe(2);
    expect(out.summary.results).toEqual([
      {
        claim: 'Claim A.',
        status: 'verified',
        supportingUrls: ['https://a.example/1', 'https://a.example/2'],
      },
      { claim: 'Claim B.', status: 'unverified', supportingUrls: [] },
    ]);
    expect(out.summary.searchesUsed).toBe(2);
    expect(out.summary.budgetExhausted).toBe(false);
  });

  it('returns budgetExhausted=true and skips the LLM call when search is empty', async () => {
    const search = { remaining: () => 0, search: vi.fn() };
    const generate = vi.fn();

    const out = await factCheckDraft({
      draft: 'irrelevant',
      maxClaims: 8,
      search: search as never,
      modelId: 'mock-model',
      generateFn: generate as never,
    });

    expect(out.llmCallsAttempted).toBe(0);
    expect(out.summary.budgetExhausted).toBe(true);
    expect(out.summary.results).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
  });

  it('marks remaining claims as not_checked when search budget runs out mid-loop', async () => {
    let remaining = 1;
    const search = {
      remaining: () => remaining,
      search: vi
        .fn()
        .mockImplementationOnce(async () => {
          remaining = 0;
          return [{ title: 'A', url: 'https://a.example', snippet: '' }];
        })
        .mockImplementation(async () => {
          throw new SearchBudgetExhaustedError();
        }),
    };
    const generate = vi.fn().mockResolvedValue('Claim 1.\nClaim 2.\nClaim 3.');

    const out = await factCheckDraft({
      draft: 'irrelevant',
      maxClaims: 8,
      search: search as never,
      modelId: 'mock-model',
      generateFn: generate as never,
    });

    expect(out.summary.results.map((r) => r.status)).toEqual([
      'verified',
      'not_checked',
      'not_checked',
    ]);
    expect(out.summary.budgetExhausted).toBe(true);
  });

  it('returns an empty summary and llmCallsAttempted=1 when claim extraction throws', async () => {
    const search = { remaining: () => 10, search: vi.fn() };
    const generate = vi.fn().mockRejectedValue(new Error('llm down'));

    const out = await factCheckDraft({
      draft: 'irrelevant',
      maxClaims: 8,
      search: search as never,
      modelId: 'mock-model',
      generateFn: generate as never,
    });

    expect(out.llmCallsAttempted).toBe(1);
    expect(out.summary.results).toEqual([]);
    expect(out.summary.claimsExtracted).toBe(0);
    expect(search.search).not.toHaveBeenCalled();
  });

  it('treats SearchProviderError as unverified and continues', async () => {
    const search = {
      remaining: () => 10,
      search: vi
        .fn()
        .mockRejectedValueOnce(new SearchProviderError('boom', ['firecrawl']))
        .mockResolvedValueOnce([{ title: 'X', url: 'https://x.example', snippet: '' }]),
    };
    const generate = vi.fn().mockResolvedValue('Claim 1.\nClaim 2.');

    const out = await factCheckDraft({
      draft: 'irrelevant',
      maxClaims: 8,
      search: search as never,
      modelId: 'mock-model',
      generateFn: generate as never,
    });

    expect(out.summary.results.map((r) => r.status)).toEqual(['unverified', 'verified']);
    expect(out.summary.searchesUsed).toBe(2);
  });
});

describe('runResearchPipeline critique + revision loop', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
    process.env.MAX_RESEARCH_ITERATIONS = '5';
    process.env.MAX_LLM_CALLS_PER_RESEARCH = '10';
  });

  function setupConversation() {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
  }

  function setupHistory() {
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Climate impacts on agriculture', metadata: null },
      {
        role: 'assistant',
        content: 'READY: scope',
        metadata: { kind: 'research_ready', summary: 'scope' },
      },
    ] as never);
  }

  function setupSearch() {
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
        { title: 'B', url: 'https://b.example', snippet: 'sb' },
        { title: 'C', url: 'https://c.example', snippet: 'sc' },
      ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    return fakeSearch;
  }

  function setupPersistence() {
    mockedPrisma.message.create.mockResolvedValue({
      id: 'm-final',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'final',
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
  }

  it('exits with all_passed on first critique when scores are >= 4', async () => {
    setupConversation();
    setupHistory();
    setupSearch();
    setupPersistence();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.exitReason).toBe('all_passed');
      expect(out.iterations).toHaveLength(1);
      expect(out.iterations[0].revised).toBe(false);
      // 4 calls: planning, draft, one critique, report
      expect(out.llmCallsUsed).toBe(4);
    }
    expect(mockedGenerate).toHaveBeenCalledTimes(4);
  });

  it('runs critique → fact-check → revise → critique and exits when scores pass', async () => {
    setupConversation();
    setupHistory();
    setupSearch();
    setupPersistence();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('Claim one.\nClaim two.')
      .mockResolvedValueOnce('Revised draft with significantly more breadth and depth.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.exitReason).toBe('all_passed');
      expect(out.iterations).toHaveLength(2);
      expect(out.iterations[0].revised).toBe(true);
      expect(out.iterations[0].weakest).toContain('completeness');
      expect(out.iterations[0].factCheck?.claimsExtracted).toBe(2);
      expect(out.iterations[1].revised).toBe(false);
    }

    const final = mockedPrisma.message.create.mock.calls[0][0] as {
      data: { content: string; metadata: { iterationCount: number; exitReason: string } };
    };
    expect(final.data.content).toBe(
      'Revised draft with significantly more breadth and depth.',
    );
    expect(final.data.metadata.iterationCount).toBe(2);
    expect(final.data.metadata.exitReason).toBe('all_passed');
  });

  it('caps iterations at MAX_RESEARCH_ITERATIONS', async () => {
    process.env.MAX_RESEARCH_ITERATIONS = '2';
    setupConversation();
    setupHistory();
    setupSearch();
    setupPersistence();
    // planning + draft + (critique fail + fact-check + revise) + (critique fail) + report = 7 calls
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Draft v1.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('Claim A.\nClaim B.')
      .mockResolvedValueOnce('Draft v2 with very different wording entirely throughout.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.exitReason).toBe('iterations_exhausted');
      expect(out.iterations).toHaveLength(2);
    }
    expect(mockedGenerate).toHaveBeenCalledTimes(7);
  });

  it('stops with budget_exhausted before exceeding MAX_LLM_CALLS_PER_RESEARCH', async () => {
    // Budget 4 = planning + draft + 1 critique + 1 fact-check; no room for revise
    process.env.MAX_LLM_CALLS_PER_RESEARCH = '4';
    setupConversation();
    setupHistory();
    setupSearch();
    setupPersistence();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Draft v1.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('Claim A.\nClaim B.');

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.exitReason).toBe('budget_exhausted');
      expect(out.llmCallsUsed).toBeLessThanOrEqual(4);
      expect(out.iterations[0].revised).toBe(false);
    }
    expect(mockedGenerate).toHaveBeenCalledTimes(4);
  });

  it('exits with converged when revision text barely changes', async () => {
    setupConversation();
    setupHistory();
    setupSearch();
    setupPersistence();
    const draft = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('Claim A.\nClaim B.')
      .mockResolvedValueOnce(draft); // identical revision → similarity 1

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.exitReason).toBe('converged');
      expect(out.iterations).toHaveLength(1);
      expect(out.iterations[0].revised).toBe(true);
    }
  });

  it('emits critiquing, fact_checking, and revising progress events with iteration numbers', async () => {
    setupConversation();
    setupHistory();
    setupSearch();
    setupPersistence();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Draft v1.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('Claim A.\nClaim B.')
      .mockResolvedValueOnce('Draft v2 with broader scope and richer sourcing.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE);

    const events: {
      stage: string;
      iteration?: number;
      weakestCriteria?: string[];
      claimsExtracted?: number;
      claimsVerified?: number;
    }[] = [];
    await runResearchPipeline({
      userId: USER_ID,
      conversationId: 'conv-1',
      onProgress: (p) => events.push(p),
    });

    const critique1 = events.find((e) => e.stage === 'critiquing' && e.iteration === 1);
    const factCheck1 = events.filter(
      (e) => e.stage === 'fact_checking' && e.iteration === 1,
    );
    const revising1 = events.find((e) => e.stage === 'revising' && e.iteration === 1);
    const critique2 = events.find((e) => e.stage === 'critiquing' && e.iteration === 2);
    expect(critique1).toBeDefined();
    expect(factCheck1.length).toBeGreaterThanOrEqual(2); // start + summary
    expect(factCheck1[factCheck1.length - 1].claimsExtracted).toBe(2);
    expect(revising1).toBeDefined();
    expect(revising1!.weakestCriteria).toContain('completeness');
    expect(critique2).toBeDefined();
  });

  it('exits with critique_parse_failed if the critic produces unparseable output', async () => {
    setupConversation();
    setupHistory();
    setupSearch();
    setupPersistence();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce('totally not a valid critique format');

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.exitReason).toBe('critique_parse_failed');
      expect(out.iterations).toHaveLength(0);
      expect(out.finalScores).toBeNull();
    }
  });

  it('returns ai-error when critique LLM call throws', async () => {
    setupConversation();
    setupHistory();
    setupSearch();
    mockedPrisma.conversation.update.mockResolvedValue({} as never);
    mockedPrisma.message.create.mockResolvedValue({} as never);
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockRejectedValueOnce(new Error('critique boom'));

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ai-error');
    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { researchStatus: 'failed', updatedAt: expect.any(Date) },
    });
    // A research_failed message is persisted, but no research_final.
    const finalKinds = mockedPrisma.message.create.mock.calls.map((call) => {
      const data = (call[0] as { data?: { metadata?: { kind?: string } } }).data;
      return data?.metadata?.kind;
    });
    expect(finalKinds).not.toContain('research_final');
    expect(finalKinds).toContain('research_failed');
  });

  it('stores fact-check results in iteration metadata and revise prompt sees them', async () => {
    setupConversation();
    setupHistory();
    // Track only initial-search queries; fact-check uses a different search() pattern
    let factCheckSearches = 0;
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockImplementation(async (q: string) => {
        if (q.startsWith('q')) {
          // initial query searches
          return [
            { title: 'A', url: 'https://a.example', snippet: 'sa' },
            { title: 'B', url: 'https://b.example', snippet: 'sb' },
            { title: 'C', url: 'https://c.example', snippet: 'sc' },
          ];
        }
        // claim verification searches
        factCheckSearches += 1;
        if (factCheckSearches === 1) {
          return [{ title: 'V', url: 'https://v.example', snippet: '' }];
        }
        return [];
      }),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    setupPersistence();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('First claim.\nSecond claim.')
      .mockResolvedValueOnce('Revised draft addressing the critique and fact-check.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.iterations[0].factCheck).toBeDefined();
      expect(out.iterations[0].factCheck!.results).toHaveLength(2);
      expect(out.iterations[0].factCheck!.results[0].status).toBe('verified');
      expect(out.iterations[0].factCheck!.results[1].status).toBe('unverified');
    }

    // The revise prompt (5th call: planning, draft, critique, claim-extract, revise) sees fact-check
    const revisePrompt = (mockedGenerate.mock.calls[4][0] as Array<{ content: string }>)
      .map((m) => m.content)
      .join('\n');
    expect(revisePrompt).toContain('FACT-CHECK RESULTS:');
    expect(revisePrompt).toContain('[VERIFIED] First claim.');
    expect(revisePrompt).toContain('[UNVERIFIED] Second claim.');

    // Final metadata persists fact-check on the iteration
    const final = mockedPrisma.message.create.mock.calls[0][0] as {
      data: {
        metadata: {
          iterations: Array<{ factCheck?: { results: Array<{ status: string }> } }>;
        };
      };
    };
    expect(final.data.metadata.iterations[0].factCheck).toBeDefined();
    expect(final.data.metadata.iterations[0].factCheck!.results).toHaveLength(2);
  });

  it('skips fact-check entirely when search budget is exhausted', async () => {
    setupConversation();
    setupHistory();
    setupPersistence();
    let rem = 2;
    const fakeSearch = {
      remaining: vi.fn().mockImplementation(() => rem),
      search: vi
        .fn()
        .mockImplementationOnce(async () => {
          rem -= 1;
          return [{ title: 'A', url: 'https://a.example', snippet: 'sa' }];
        })
        .mockImplementationOnce(async () => {
          rem = 0;
          return [
            { title: 'B', url: 'https://b.example', snippet: 'sb' },
            { title: 'C', url: 'https://c.example', snippet: 'sc' },
          ];
        }),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);

    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('Revised draft directly addressing the critique.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.iterations[0].factCheck).toBeUndefined();
      expect(out.iterations[0].revised).toBe(true);
    }
    // 6 calls: planning, draft, critique, revise, critique, report. NO claim extraction.
    expect(mockedGenerate).toHaveBeenCalledTimes(6);
  });
});

describe('parseStructuredReport', () => {
  it('parses the three required sections', () => {
    const out = parseStructuredReport(`EXECUTIVE_SUMMARY:
A short summary.

KEY_FINDINGS:
- one
- two
- three

DETAILED_ANALYSIS:
A longer body of text.`);
    expect(out).not.toBeNull();
    expect(out!.executiveSummary).toBe('A short summary.');
    expect(out!.keyFindings).toEqual(['one', 'two', 'three']);
    expect(out!.detailedAnalysis).toBe('A longer body of text.');
  });

  it('returns null when a section is missing', () => {
    expect(parseStructuredReport('only a summary')).toBeNull();
    expect(
      parseStructuredReport(`EXECUTIVE_SUMMARY:\nx\n\nKEY_FINDINGS:\n- y`),
    ).toBeNull();
  });

  it('handles numbered findings and strips markers', () => {
    const out = parseStructuredReport(`EXECUTIVE_SUMMARY:
ok

KEY_FINDINGS:
1. alpha
2. beta
3. gamma

DETAILED_ANALYSIS:
body`);
    expect(out!.keyFindings).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns null when sections are present but empty', () => {
    const out = parseStructuredReport(`EXECUTIVE_SUMMARY:


KEY_FINDINGS:


DETAILED_ANALYSIS:
`);
    expect(out).toBeNull();
  });
});

describe('computeReportSources', () => {
  it('marks sources verified when their URL appears in any verified fact-check claim', () => {
    const sources = [
      { title: 'A', url: 'https://a.example', snippet: '' },
      { title: 'B', url: 'https://b.example', snippet: '' },
      { title: 'C', url: 'https://c.example', snippet: '' },
    ];
    const iterations = [
      {
        iteration: 1,
        scores: {
          factual_accuracy: 4,
          completeness: 4,
          source_coverage: 4,
          coherence: 4,
          scope_alignment: 4,
        },
        critique: 'ok',
        weakest: [],
        revised: false,
        factCheck: {
          results: [
            {
              claim: 'c1',
              status: 'verified' as const,
              supportingUrls: ['https://a.example', 'https://c.example'],
            },
            { claim: 'c2', status: 'unverified' as const, supportingUrls: [] },
          ],
          claimsExtracted: 2,
          searchesUsed: 2,
          budgetExhausted: false,
        },
      },
    ];
    const reliability = computeReportSources(sources, iterations).map((s) => ({
      url: s.url,
      r: s.reliability,
    }));
    expect(reliability).toEqual([
      { url: 'https://a.example', r: 'verified' },
      { url: 'https://b.example', r: 'unknown' },
      { url: 'https://c.example', r: 'verified' },
    ]);
  });

  it('marks all sources unknown when there is no fact-check', () => {
    const sources = [{ title: 'A', url: 'https://a.example', snippet: '' }];
    const reliability = computeReportSources(sources, []).map((s) => s.reliability);
    expect(reliability).toEqual(['unknown']);
  });
});

describe('computeReportMethodology', () => {
  it('aggregates fact-check results across iterations', () => {
    const m = computeReportMethodology(
      ['q1', 'q2'],
      [
        {
          iteration: 1,
          scores: {
            factual_accuracy: 3,
            completeness: 3,
            source_coverage: 3,
            coherence: 3,
            scope_alignment: 3,
          },
          critique: 'c',
          weakest: ['factual_accuracy'],
          revised: true,
          factCheck: {
            results: [
              { claim: '1', status: 'verified' as const, supportingUrls: [] },
              { claim: '2', status: 'unverified' as const, supportingUrls: [] },
              { claim: '3', status: 'not_checked' as const, supportingUrls: [] },
            ],
            claimsExtracted: 3,
            searchesUsed: 2,
            budgetExhausted: true,
          },
        },
        {
          iteration: 2,
          scores: {
            factual_accuracy: 4,
            completeness: 4,
            source_coverage: 4,
            coherence: 4,
            scope_alignment: 4,
          },
          critique: 'c2',
          weakest: [],
          revised: false,
        },
      ],
      {
        factual_accuracy: 4,
        completeness: 4,
        source_coverage: 4,
        coherence: 4,
        scope_alignment: 4,
      },
    );
    expect(m.queries).toEqual(['q1', 'q2']);
    expect(m.iterationCount).toBe(2);
    expect(m.factCheckSummary).toEqual({
      totalClaimsExtracted: 3,
      verifiedClaims: 1,
      unverifiedClaims: 1,
      notCheckedClaims: 1,
    });
  });
});

describe('programmaticReportFromDraft', () => {
  it('falls back to draft-based sections when LLM is unavailable', () => {
    const report = programmaticReportFromDraft(
      `First sentence. Second sentence.

- bullet one
- bullet two
- bullet three`,
      [{ title: 'A', url: 'https://a.example', snippet: '' }],
      [],
      ['q1'],
      null,
    );
    expect(report.executiveSummary).toContain('First sentence.');
    expect(report.keyFindings).toEqual(['bullet one', 'bullet two', 'bullet three']);
    expect(report.detailedAnalysis).toContain('bullet one');
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].index).toBe(1);
    expect(report.methodology.queries).toEqual(['q1']);
  });
});

describe('buildStructuredReport', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);
  beforeEach(() => {
    vi.clearAllMocks();
    void mockedCreateSearchService;
  });

  it('uses LLM output when parseable', async () => {
    const run = await buildStructuredReport({
      draft: 'Draft body.',
      topic: 'T',
      summary: 'S',
      sources: [{ title: 'A', url: 'https://a.example', snippet: '' }],
      iterations: [],
      queries: ['q1'],
      finalScores: null,
      modelId: 'm',
      generateFn: vi.fn().mockResolvedValue(MOCK_REPORT) as never,
    });
    expect(run.source).toBe('llm');
    expect(run.llmCallsAttempted).toBe(1);
    expect(run.report.keyFindings.length).toBeGreaterThan(0);
    expect(run.report.sources[0].url).toBe('https://a.example');
  });

  it('falls back to programmatic when LLM throws', async () => {
    const run = await buildStructuredReport({
      draft: 'Draft body. Second sentence.',
      topic: 'T',
      summary: 'S',
      sources: [{ title: 'A', url: 'https://a.example', snippet: '' }],
      iterations: [],
      queries: ['q1'],
      finalScores: null,
      modelId: 'm',
      generateFn: vi.fn().mockRejectedValue(new Error('boom')) as never,
    });
    expect(run.source).toBe('programmatic');
    expect(run.llmCallsAttempted).toBe(1);
    expect(run.report.detailedAnalysis).toContain('Draft body.');
  });

  it('falls back to programmatic when LLM output is unparseable', async () => {
    const run = await buildStructuredReport({
      draft: 'Draft. Second.',
      topic: 'T',
      summary: 'S',
      sources: [],
      iterations: [],
      queries: [],
      finalScores: null,
      modelId: 'm',
      generateFn: vi.fn().mockResolvedValue('totally bogus output') as never,
    });
    expect(run.source).toBe('programmatic');
  });
});

describe('runResearchPipeline structured report integration', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
    process.env.MAX_RESEARCH_ITERATIONS = '5';
    process.env.MAX_LLM_CALLS_PER_RESEARCH = '10';
  });

  function setupCommon() {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini' },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'topic', metadata: null },
      {
        role: 'assistant',
        content: 'READY: scope',
        metadata: { kind: 'research_ready', summary: 'scope' },
      },
    ] as never);
    mockedCreateSearchService.mockReturnValue({
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
        { title: 'B', url: 'https://b.example', snippet: 'sb' },
        { title: 'C', url: 'https://c.example', snippet: 'sc' },
      ]),
    } as never);
    mockedPrisma.message.create.mockResolvedValue({
      id: 'm-final',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'final',
      createdAt: new Date(),
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'topic',
      mode: 'research',
      researchStatus: 'complete',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
  }

  it('persists the structured report in research_final metadata', async () => {
    setupCommon();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft body [1] [2] [3].')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.report.executiveSummary).toContain('concise overview');
      expect(out.report.keyFindings).toHaveLength(3);
    }
    const stored = mockedPrisma.message.create.mock.calls[0][0] as {
      data: { metadata: { report?: { executiveSummary: string; keyFindings: string[] } } };
    };
    expect(stored.data.metadata.report).toBeDefined();
    expect(stored.data.metadata.report!.executiveSummary).toContain('concise overview');
    expect(stored.data.metadata.report!.keyFindings).toHaveLength(3);
  });

  it('emits a finalizing progress event with report stage', async () => {
    setupCommon();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Draft.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const stages: string[] = [];
    await runResearchPipeline({
      userId: USER_ID,
      conversationId: 'conv-1',
      onProgress: (p) => stages.push(p.stage),
    });
    expect(stages).toContain('finalizing');
  });

  it('falls back to programmatic report when LLM call budget is exhausted', async () => {
    process.env.MAX_LLM_CALLS_PER_RESEARCH = '3';
    setupCommon();
    // 3 calls: planning, draft, critique (all_passed). No room for report → programmatic.
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce(
        'Initial draft.\n- bullet one\n- bullet two\n- bullet three',
      )
      .mockResolvedValueOnce(PERFECT_CRITIQUE);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.llmCallsUsed).toBe(3);
      expect(out.report.keyFindings.length).toBeGreaterThan(0);
      // Report sources should still be present
      expect(out.report.sources).toHaveLength(3);
    }
    expect(mockedGenerate).toHaveBeenCalledTimes(3);
  });
});

describe('getLatestResearchFinal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the conversation is not owned by the user', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: OTHER_USER_ID,
      title: 't',
    } as never);
    const out = await getLatestResearchFinal(USER_ID, 'conv-1');
    expect(out).toBeNull();
  });

  it('returns the latest research_final with parsed report', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Climate',
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      {
        content: 'older final',
        metadata: {
          kind: 'research_final',
          report: {
            executiveSummary: 'old',
            keyFindings: [],
            detailedAnalysis: 'old',
            sources: [],
            methodology: {
              queries: [],
              iterationCount: 0,
              finalScores: null,
              factCheckSummary: {
                totalClaimsExtracted: 0,
                verifiedClaims: 0,
                unverifiedClaims: 0,
                notCheckedClaims: 0,
              },
            },
          },
        },
      },
    ] as never);
    const out = await getLatestResearchFinal(USER_ID, 'conv-1');
    expect(out).not.toBeNull();
    expect(out!.topic).toBe('Climate');
    expect(out!.report.executiveSummary).toBe('old');
  });

  it('returns null when no research_final messages exist', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 't',
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { content: 'hello', metadata: null },
      { content: 'questions', metadata: { kind: 'clarifying_questions', questions: [] } },
    ] as never);
    const out = await getLatestResearchFinal(USER_ID, 'conv-1');
    expect(out).toBeNull();
  });
});

describe('GET /api/conversations/:id/research/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/conversations/conv-1/research/pdf');
    expect(res.status).toBe(401);
  });

  it('returns 404 when no research_final exists', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 't',
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([] as never);

    const res = await request(app)
      .get('/api/conversations/conv-1/research/pdf')
      .set('Cookie', 'session_id=session-1');
    expect(res.status).toBe(404);
  });

  it('streams a PDF with the report content', async () => {
    authedSession();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Climate Topic',
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      {
        content: 'final draft',
        metadata: {
          kind: 'research_final',
          report: {
            executiveSummary: 'Summary text.',
            keyFindings: ['one', 'two'],
            detailedAnalysis: 'Body.',
            sources: [
              { index: 1, title: 'A', url: 'https://a.example', reliability: 'verified' },
            ],
            methodology: {
              queries: ['q1'],
              iterationCount: 1,
              finalScores: {
                factual_accuracy: 5,
                completeness: 5,
                source_coverage: 5,
                coherence: 5,
                scope_alignment: 5,
              },
              factCheckSummary: {
                totalClaimsExtracted: 0,
                verifiedClaims: 0,
                unverifiedClaims: 0,
                notCheckedClaims: 0,
              },
            },
          },
        },
      },
    ] as never);

    const res = await request(app)
      .get('/api/conversations/conv-1/research/pdf')
      .set('Cookie', 'session_id=session-1')
      .buffer(true);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.pdf');
    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(500);
    expect(body.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('Follow-up messages in research mode with status=complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
    mockedPrisma.message.count.mockResolvedValue(0 as never);
  });

  it('injects research context into the model messages', async () => {
    authedSession();
    // Preflight (chat handler dispatch decision)
    mockedPrisma.conversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'complete',
    } as never);
    // appendUserMessage ownership
    mockedPrisma.conversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Topic',
    } as never);
    // getLatestResearchFinal lookup
    mockedPrisma.conversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Topic',
    } as never);

    mockedPrisma.message.create.mockResolvedValueOnce({
      id: 'user-msg',
      conversationId: 'conv-1',
      role: 'user',
      content: 'more detail please',
      createdAt: new Date(),
    } as never);
    // appendUserMessage's history fetch
    mockedPrisma.message.findMany.mockResolvedValueOnce([
      { role: 'user', content: 'topic' },
      { role: 'assistant', content: 'final draft' },
      { role: 'user', content: 'more detail please' },
    ] as never);
    // getLatestResearchFinal's message fetch
    mockedPrisma.message.findMany.mockResolvedValueOnce([
      {
        content: 'final draft',
        metadata: {
          kind: 'research_final',
          report: {
            executiveSummary: 'EXEC',
            keyFindings: ['kf1'],
            detailedAnalysis: 'body',
            sources: [
              { index: 1, title: 'A', url: 'https://a.example', reliability: 'verified' },
            ],
            methodology: {
              queries: [],
              iterationCount: 1,
              finalScores: null,
              factCheckSummary: {
                totalClaimsExtracted: 0,
                verifiedClaims: 0,
                unverifiedClaims: 0,
                notCheckedClaims: 0,
              },
            },
          },
        },
      },
    ] as never);

    mockedPrisma.user.findUnique.mockResolvedValue({
      preferredModel: 'openai:gpt-4o-mini',
      streamingEnabled: false,
    } as never);

    mockedGenerate.mockResolvedValueOnce('Expanded answer.');
    mockedPrisma.message.create.mockResolvedValueOnce({
      id: 'asst-msg',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Expanded answer.',
      createdAt: new Date(),
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({} as never);

    const res = await request(app)
      .post('/api/conversations/conv-1/messages?stream=false')
      .set('Cookie', 'session_id=session-1')
      .send({ content: 'more detail please' });

    expect(res.status).toBe(201);
    const aiCall = mockedGenerate.mock.calls[0];
    const llmMessages = aiCall[0] as Array<{ role: string; content: string }>;
    const systemContents = llmMessages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemContents).toContain('[Research context for follow-up questions]');
    expect(systemContents).toContain('EXEC');
    expect(systemContents).toContain('https://a.example');
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
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Draft body.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE);
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

describe('Phase 7: email notification on completion', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGenerate.mockReset();
    _resetActiveResearch();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
  });

  it('sends a research completion email after the pipeline succeeds', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: {
        preferredModel: 'openai:gpt-4o-mini',
        email: 'recipient@example.com',
      },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Climate impacts on agriculture', metadata: null },
      {
        role: 'assistant',
        content: 'READY: scope',
        metadata: { kind: 'research_ready', summary: 'scope' },
      },
    ] as never);
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
      id: 'm-final',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'final',
      createdAt: new Date(),
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Climate impacts on agriculture',
      mode: 'research',
      researchStatus: 'complete',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const out = await runResearchPipeline({
      userId: USER_ID,
      conversationId: 'conv-1',
    });

    expect(out.kind).toBe('ok');
    // Fire-and-forget: yield once so the unawaited email promise resolves
    await new Promise((r) => setImmediate(r));
    expect(mockedSendResearchCompleteEmail).toHaveBeenCalledTimes(1);
    const call = mockedSendResearchCompleteEmail.mock.calls[0][0];
    expect(call.email).toBe('recipient@example.com');
    expect(call.conversationId).toBe('conv-1');
    expect(call.topic).toBe('Climate impacts on agriculture');
    expect(call.report.executiveSummary).toBeDefined();
  });

  it('skips email when the user has no email address on record', async () => {
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
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
        { title: 'B', url: 'https://b.example', snippet: 'sb' },
        { title: 'C', url: 'https://c.example', snippet: 'sc' },
      ]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.message.create.mockResolvedValue({ id: 'm', conversationId: 'conv-1', role: 'assistant', content: 'final', createdAt: new Date() } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Topic',
      mode: 'research',
      researchStatus: 'complete',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    await new Promise((r) => setImmediate(r));

    expect(mockedSendResearchCompleteEmail).not.toHaveBeenCalled();
  });

  it('does not send an email when the pipeline fails (e.g., insufficient sources)', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini', email: 'r@example.com' },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Topic', metadata: null },
    ] as never);
    mockedGenerate.mockResolvedValueOnce('q1\nq2');
    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi
        .fn()
        .mockResolvedValue([{ title: 'A', url: 'https://a.example', snippet: '' }]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.conversation.update.mockResolvedValue({} as never);
    mockedPrisma.message.create.mockResolvedValue({} as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    await new Promise((r) => setImmediate(r));

    expect(out.kind).toBe('insufficient-sources');
    expect(mockedSendResearchCompleteEmail).not.toHaveBeenCalled();
  });
});

describe('Phase 7: single-active-research mutex', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGenerate.mockReset();
    _resetActiveResearch();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
  });

  it('reports busy when a second pipeline starts while the first is still running', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini', email: 'r@example.com' },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Topic', metadata: null },
    ] as never);
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
      id: 'm',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'final',
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

    // The first pipeline call hangs on the planning LLM call until we resolve it.
    let resolvePlanning!: (value: string) => void;
    const planningPromise = new Promise<string>((r) => {
      resolvePlanning = r;
    });
    mockedGenerate
      .mockReturnValueOnce(planningPromise as never)
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const first = runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    // Yield so first awaits the planning promise and the mutex is acquired.
    await new Promise((r) => setImmediate(r));
    expect(isResearchActiveForUser(USER_ID)).toBe(true);

    const busy = await runResearchPipeline({
      userId: USER_ID,
      conversationId: 'conv-2',
    });
    expect(busy.kind).toBe('busy');

    resolvePlanning('q1\nq2');
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe('ok');
    expect(isResearchActiveForUser(USER_ID)).toBe(false);
  });

  it('releases the mutex when the pipeline throws an unexpected error', async () => {
    mockedPrisma.conversation.findUnique.mockRejectedValueOnce(new Error('db down'));

    await expect(
      runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' }),
    ).rejects.toThrow('db down');

    expect(isResearchActiveForUser(USER_ID)).toBe(false);
  });

  it('returns 409 + RESEARCH_BUSY from POST /:id/research/run when already active', async () => {
    authedSession();
    _acquireActiveResearch(USER_ID);

    const res = await request(app)
      .post('/api/conversations/conv-2/research/run')
      .set('Cookie', 'session_id=session-1')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESEARCH_BUSY');
  });
});

describe('Phase 7: failure messages persisted to conversation', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGenerate.mockReset();
    _resetActiveResearch();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
  });

  it('creates an assistant message with kind=research_failed on insufficient-sources', async () => {
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
      search: vi
        .fn()
        .mockResolvedValue([{ title: 'A', url: 'https://a.example', snippet: '' }]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);
    mockedPrisma.conversation.update.mockResolvedValue({} as never);
    mockedPrisma.message.create.mockResolvedValue({} as never);

    await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    const messageCreate = mockedPrisma.message.create.mock.calls.find(
      (call) => {
        const data = (call[0] as { data?: { metadata?: { kind?: string } } }).data;
        return data?.metadata?.kind === 'research_failed';
      },
    );
    expect(messageCreate).toBeDefined();
    const data = (messageCreate![0] as { data: { role: string; metadata: { kind: string; reason: string } } }).data;
    expect(data.role).toBe('assistant');
    expect(data.metadata.kind).toBe('research_failed');
    expect(data.metadata.reason).toMatch(/source/i);
  });

  it('creates a research_failed message when planning LLM throws', async () => {
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
    mockedGenerate.mockRejectedValueOnce(new Error('planning down'));
    mockedPrisma.conversation.update.mockResolvedValue({} as never);
    mockedPrisma.message.create.mockResolvedValue({} as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(out.kind).toBe('ai-error');
    const messageCreate = mockedPrisma.message.create.mock.calls.find(
      (call) => {
        const data = (call[0] as { data?: { metadata?: { kind?: string } } }).data;
        return data?.metadata?.kind === 'research_failed';
      },
    );
    expect(messageCreate).toBeDefined();
  });
});

describe('Phase 8: preferredModel propagation through the research pipeline', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGenerate.mockReset();
    _resetActiveResearch();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
  });

  it('passes the user\'s preferredModel to every LLM call in the pipeline', async () => {
    const preferred = 'ollama:llama3.1';
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: preferred, email: null },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Climate impacts on agriculture', metadata: null },
      {
        role: 'assistant',
        content: 'READY: focus on EU through 2030.',
        metadata: { kind: 'research_ready', summary: 'focus on EU through 2030' },
      },
    ] as never);

    mockedGenerate
      .mockResolvedValueOnce('eu agriculture climate impacts\nheat stress crops eu')
      .mockResolvedValueOnce('Draft body with citations [1] [2] [3].')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const fakeSearch = {
      remaining: vi.fn().mockReturnValue(20),
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { title: 'A', url: 'https://a.example', snippet: 'sa' },
          { title: 'B', url: 'https://b.example', snippet: 'sb' },
          { title: 'C', url: 'https://c.example', snippet: 'sc' },
        ])
        .mockResolvedValue([]),
    };
    mockedCreateSearchService.mockReturnValue(fakeSearch as never);

    mockedPrisma.message.create.mockResolvedValue({
      id: 'm-final',
      conversationId: 'conv-1',
      role: 'assistant',
      content: '',
      createdAt: new Date(),
    } as never);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      title: 'Climate',
      mode: 'research',
      researchStatus: 'complete',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ok');

    expect(mockedGenerate).toHaveBeenCalled();
    for (const call of mockedGenerate.mock.calls) {
      expect(call[1]).toBe(preferred);
    }
  });

  it('falls back to the default model when preferredModel is null', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: null, email: null },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Topic', metadata: null },
    ] as never);
    mockedGenerate.mockRejectedValueOnce(new Error('stop here'));
    mockedPrisma.conversation.update.mockResolvedValue({} as never);
    mockedPrisma.message.create.mockResolvedValue({} as never);

    await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(mockedGenerate).toHaveBeenCalled();
    expect(mockedGenerate.mock.calls[0][1]).toBe('openai:gpt-4o-mini');
  });

  it('falls back to the default model when preferredModel is unsupported', async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'made-up:not-a-real-model', email: null },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Topic', metadata: null },
    ] as never);
    mockedGenerate.mockRejectedValueOnce(new Error('stop here'));
    mockedPrisma.conversation.update.mockResolvedValue({} as never);
    mockedPrisma.message.create.mockResolvedValue({} as never);

    await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });

    expect(mockedGenerate).toHaveBeenCalled();
    expect(mockedGenerate.mock.calls[0][1]).toBe('openai:gpt-4o-mini');
  });
});

describe('runResearchPipeline tracing instrumentation', () => {
  const mockedCreateSearchService = vi.mocked(createSearchService);

  beforeEach(() => {
    vi.clearAllMocks();
    clearTraceRecorder();
    mockedPrisma.file.findMany.mockResolvedValue([] as never);
    process.env.MAX_RESEARCH_ITERATIONS = '5';
    process.env.MAX_LLM_CALLS_PER_RESEARCH = '10';
  });

  function setupOk() {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      userId: USER_ID,
      mode: 'research',
      researchStatus: 'researching',
      user: { preferredModel: 'openai:gpt-4o-mini', email: 'u@example.com' },
    } as never);
    mockedPrisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'Topic on EU climate impacts', metadata: null },
      {
        role: 'assistant',
        content: '1. Region?',
        metadata: { kind: 'clarifying_questions', questions: ['Region?'] },
      },
      { role: 'user', content: 'EU only', metadata: null },
      {
        role: 'assistant',
        content: 'READY: focus on EU through 2030.',
        metadata: { kind: 'research_ready', summary: 'focus on EU through 2030.' },
      },
    ] as never);
    mockedCreateSearchService.mockReturnValue({
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
        { title: 'B', url: 'https://b.example', snippet: 'sb' },
        { title: 'C', url: 'https://c.example', snippet: 'sc' },
      ]),
    } as never);
    mockedPrisma.message.create.mockResolvedValue({
      id: 'm-final',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'final',
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
  }

  it('creates a trace, emits searching/drafting/critiquing/finalizing spans, and finishes with exitReason on the happy path', async () => {
    setupOk();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ok');

    expect(traceInits).toHaveLength(1);
    const init = traceInits[0] as {
      userId: string;
      conversationId: string;
      topic: string;
      modelId: string;
      clarifyingAnswers: string[];
      scopeSummary?: string;
    };
    expect(init.userId).toBe(USER_ID);
    expect(init.conversationId).toBe('conv-1');
    expect(init.topic).toBe('Topic on EU climate impacts');
    expect(init.modelId).toBe('openai:gpt-4o-mini');
    expect(init.clarifyingAnswers).toEqual(['EU only']);
    expect(init.scopeSummary).toBe('focus on EU through 2030.');

    const spanNames = traceSpans.map((s) => s.name);
    expect(spanNames).toEqual(['searching', 'drafting', 'critiquing', 'finalizing']);

    expect(traceFinishes).toHaveLength(1);
    const finish = traceFinishes[0] as {
      exitReason?: string;
      output?: { exitReason?: string; sourceCount?: number };
    };
    expect(finish.exitReason).toBe('all_passed');
    expect(finish.output?.exitReason).toBe('all_passed');
    expect(finish.output?.sourceCount).toBe(3);

    const finalizingEnd = traceSpans.find((s) => s.name === 'finalizing')?.endOpts as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(finalizingEnd?.metadata?.exitReason).toBe('all_passed');
  });

  it('emits fact-checking and revising spans across iterations and finishes with the final exitReason', async () => {
    setupOk();
    mockedGenerate
      .mockResolvedValueOnce('q1\nq2')
      .mockResolvedValueOnce('Initial draft.')
      .mockResolvedValueOnce(FAILING_CRITIQUE)
      .mockResolvedValueOnce('Claim A.\nClaim B.')
      .mockResolvedValueOnce('Revised draft with very different wording entirely.')
      .mockResolvedValueOnce(PERFECT_CRITIQUE)
      .mockResolvedValueOnce(MOCK_REPORT);

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ok');

    const spanNames = traceSpans.map((s) => s.name);
    expect(spanNames).toEqual([
      'searching',
      'drafting',
      'critiquing',
      'fact-checking',
      'revising',
      'critiquing',
      'finalizing',
    ]);

    const factCheck = traceSpans.find((s) => s.name === 'fact-checking');
    expect(
      (factCheck?.endOpts as { metadata?: { claimsExtracted?: number } } | undefined)
        ?.metadata?.claimsExtracted,
    ).toBe(2);

    const revise = traceSpans.find((s) => s.name === 'revising');
    expect(
      (revise?.endOpts as { metadata?: { iteration?: number } } | undefined)?.metadata
        ?.iteration,
    ).toBe(1);

    const finish = traceFinishes[0] as { exitReason?: string };
    expect(finish.exitReason).toBe('all_passed');
  });

  it('marks the searching span as ERROR and finish with error+exitReason when planning LLM throws', async () => {
    setupOk();
    mockedGenerate.mockRejectedValueOnce(new Error('llm down'));

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('ai-error');

    const searching = traceSpans.find((s) => s.name === 'searching');
    expect(
      (searching?.endOpts as { level?: string; statusMessage?: string } | undefined)
        ?.level,
    ).toBe('ERROR');
    expect(
      (searching?.endOpts as { statusMessage?: string } | undefined)?.statusMessage,
    ).toContain('planning');

    const finish = traceFinishes[0] as { error?: string; exitReason?: string };
    expect(finish.error).toBe('planning LLM failed');
    expect(finish.exitReason).toBe('ai_error');
  });

  it('finishes with insufficient_sources exitReason when too few sources gathered', async () => {
    setupOk();
    mockedCreateSearchService.mockReturnValue({
      remaining: vi.fn().mockReturnValue(20),
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.example', snippet: 'sa' },
      ]),
    } as never);
    mockedGenerate.mockResolvedValueOnce('q1\nq2');

    const out = await runResearchPipeline({ userId: USER_ID, conversationId: 'conv-1' });
    expect(out.kind).toBe('insufficient-sources');

    const finish = traceFinishes[0] as { error?: string; exitReason?: string };
    expect(finish.error).toBe('insufficient sources');
    expect(finish.exitReason).toBe('insufficient_sources');
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
