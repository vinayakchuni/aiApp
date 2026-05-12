import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import request from 'supertest';

// Use a temp uploads dir so tests don't pollute the project root.
const TEST_UPLOAD_DIR = path.join(os.tmpdir(), `aiapp-uploads-${process.pid}`);
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;
process.env.MAX_FILES_PER_CONVERSATION = '2';
process.env.MAX_FILE_SIZE_MB = '5';

// Importing app must come AFTER env vars are set because multer reads the size
// limit at module load.
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
    session: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn() },
    file: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../services/summarize', () => ({
  summarizeFile: vi.fn(),
}));

vi.mock('../services/extract', async () => {
  const actual = await vi.importActual<typeof import('../services/extract')>(
    '../services/extract',
  );
  return {
    ...actual,
    extractText: vi.fn(async (buffer: Buffer) => `extracted:${buffer.toString('utf8')}`),
  };
});

import { prisma } from '../lib/db';
import { extractText } from '../services/extract';
import { summarizeFile } from '../services/summarize';

const mockedPrisma = vi.mocked(prisma);
const mockedExtract = vi.mocked(extractText);
const mockedSummarize = vi.mocked(summarizeFile);

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const CONV_ID = 'conv-1';

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

describe('Files API', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockedExtract.mockImplementation(async (buffer) => `extracted:${buffer.toString('utf8')}`);
    mockedSummarize.mockResolvedValue({ kind: 'ok', summary: 'summary' } as never);
    await fs.rm(TEST_UPLOAD_DIR, { recursive: true, force: true });
  });

  describe('Auth enforcement', () => {
    it('rejects POST /:id/files without session', async () => {
      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });
      expect(res.status).toBe(401);
    });

    it('rejects DELETE /:id/files/:fileId without session', async () => {
      const res = await request(app).delete(`/api/conversations/${CONV_ID}/files/file-1`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /:id/files', () => {
    it('uploads a txt file, extracts text, and returns the persisted record', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
      } as never);
      mockedPrisma.file.count.mockResolvedValue(0 as never);
      const now = new Date();
      mockedPrisma.file.create.mockResolvedValue({
        id: 'file-1',
        conversationId: CONV_ID,
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        extractedText: 'extracted:hello',
        storagePath: '/tmp/anything',
        createdAt: now,
      } as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('hello'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.file.id).toBe('file-1');
      expect(res.body.file.originalName).toBe('notes.txt');
      // public payload must not include storagePath or extractedText
      expect(res.body.file.storagePath).toBeUndefined();
      expect(res.body.file.extractedText).toBeUndefined();

      expect(mockedExtract).toHaveBeenCalledTimes(1);
      const createCall = mockedPrisma.file.create.mock.calls[0][0] as {
        data: { extractedText: string; storagePath: string };
      };
      expect(createCall.data.extractedText).toBe('extracted:hello');
      expect(createCall.data.storagePath.startsWith(TEST_UPLOAD_DIR)).toBe(true);

      // file is actually written to disk
      const written = await fs.readFile(createCall.data.storagePath, 'utf8');
      expect(written).toBe('hello');
    });

    it('kicks off summarization in the background for research conversations', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
        mode: 'research',
      } as never);
      mockedPrisma.file.count.mockResolvedValue(0 as never);
      mockedPrisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        preferredModel: 'openai:gpt-4o-mini',
      } as never);
      const now = new Date();
      mockedPrisma.file.create.mockResolvedValue({
        id: 'file-research-1',
        conversationId: CONV_ID,
        originalName: 'paper.pdf',
        mimeType: 'application/pdf',
        size: 5,
        extractedText: 'extracted:hello',
        storagePath: '/tmp/anything',
        createdAt: now,
      } as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('hello'), {
          filename: 'paper.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(201);
      // Background summarization fires; allow microtasks to settle
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockedSummarize).toHaveBeenCalledTimes(1);
      const [fileId, opts] = mockedSummarize.mock.calls[0] as [string, { preferredModel: string }];
      expect(fileId).toBe('file-research-1');
      expect(opts.preferredModel).toBe('openai:gpt-4o-mini');
    });

    it('accepts CSV uploads, stores the placeholder, and skips summarization', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
        mode: 'research',
      } as never);
      mockedPrisma.file.count.mockResolvedValue(0 as never);
      mockedPrisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        preferredModel: 'openai:gpt-4o-mini',
      } as never);
      const now = new Date();
      mockedPrisma.file.create.mockResolvedValue({
        id: 'file-csv-1',
        conversationId: CONV_ID,
        originalName: 'data.csv',
        mimeType: 'text/csv',
        size: 5,
        extractedText: 'Data file — analysis will run in sandbox',
        storagePath: '/tmp/anything',
        createdAt: now,
      } as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('a,b\n1,2'), {
          filename: 'data.csv',
          contentType: 'text/csv',
        });

      expect(res.status).toBe(201);
      // extractText is mocked at the top of the file, so we assert the route
      // accepted the upload and reached prisma.file.create.
      const createCall = mockedPrisma.file.create.mock.calls[0][0] as {
        data: { extractedText: string };
      };
      expect(createCall.data.extractedText).toBeTypeOf('string');
      await new Promise((resolve) => setImmediate(resolve));
      // Data files in a research conversation must not trigger summarization.
      expect(mockedSummarize).not.toHaveBeenCalled();
    });

    it('accepts XLSX uploads in a research conversation', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
        mode: 'research',
      } as never);
      mockedPrisma.file.count.mockResolvedValue(0 as never);
      const now = new Date();
      mockedPrisma.file.create.mockResolvedValue({
        id: 'file-xlsx-1',
        conversationId: CONV_ID,
        originalName: 'sheet.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 5,
        extractedText: 'Data file — analysis will run in sandbox',
        storagePath: '/tmp/anything',
        createdAt: now,
      } as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('xlsxbytes'), {
          filename: 'sheet.xlsx',
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });

      expect(res.status).toBe(201);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockedSummarize).not.toHaveBeenCalled();
    });

    it('does NOT kick off summarization for chat conversations', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
        mode: 'chat',
      } as never);
      mockedPrisma.file.count.mockResolvedValue(0 as never);
      const now = new Date();
      mockedPrisma.file.create.mockResolvedValue({
        id: 'file-chat-1',
        conversationId: CONV_ID,
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        extractedText: 'extracted:hello',
        storagePath: '/tmp/anything',
        createdAt: now,
      } as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('hello'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        });

      expect(res.status).toBe(201);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockedSummarize).not.toHaveBeenCalled();
    });

    it("returns 404 for another user's conversation", async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: OTHER_USER_ID,
      } as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });

      expect(res.status).toBe(404);
      expect(mockedPrisma.file.create).not.toHaveBeenCalled();
    });

    it('rejects unsupported file types with 415', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
      } as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('binary'), {
          filename: 'image.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(415);
      expect(mockedPrisma.file.create).not.toHaveBeenCalled();
    });

    it('rejects when conversation already has the maximum files (409)', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
      } as never);
      mockedPrisma.file.count.mockResolvedValue(2 as never);

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });

      expect(res.status).toBe(409);
      expect(mockedPrisma.file.create).not.toHaveBeenCalled();
    });

    it('rejects files over the size limit with 413', async () => {
      authedSession();
      // multer enforces the limit before reaching our handler, so prisma should not be touched.
      const big = Buffer.alloc(6 * 1024 * 1024, 0x61); // 6 MB
      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', big, { filename: 'big.txt', contentType: 'text/plain' });

      expect(res.status).toBe(413);
      expect(mockedPrisma.file.create).not.toHaveBeenCalled();
    });

    it('returns 422 when extraction throws', async () => {
      authedSession();
      mockedPrisma.conversation.findUnique.mockResolvedValue({
        id: CONV_ID,
        userId: USER_ID,
      } as never);
      mockedPrisma.file.count.mockResolvedValue(0 as never);
      mockedExtract.mockRejectedValueOnce(new Error('corrupt'));

      const res = await request(app)
        .post(`/api/conversations/${CONV_ID}/files`)
        .set('Cookie', 'session_id=session-1')
        .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });

      expect(res.status).toBe(422);
      expect(mockedPrisma.file.create).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:id/files/:fileId', () => {
    it('deletes an owned file from the DB and disk', async () => {
      authedSession();
      // Create a real file on disk so unlink succeeds
      await fs.mkdir(TEST_UPLOAD_DIR, { recursive: true });
      const storagePath = path.join(TEST_UPLOAD_DIR, 'sample.txt');
      await fs.writeFile(storagePath, 'sample bytes');

      mockedPrisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        storagePath,
        conversation: { id: CONV_ID, userId: USER_ID },
      } as never);
      mockedPrisma.file.delete.mockResolvedValue({} as never);

      const res = await request(app)
        .delete(`/api/conversations/${CONV_ID}/files/file-1`)
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockedPrisma.file.delete).toHaveBeenCalledWith({ where: { id: 'file-1' } });
      await expect(fs.access(storagePath)).rejects.toBeTruthy();
    });

    it("returns 404 for another user's file", async () => {
      authedSession();
      mockedPrisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        storagePath: '/tmp/x',
        conversation: { id: CONV_ID, userId: OTHER_USER_ID },
      } as never);

      const res = await request(app)
        .delete(`/api/conversations/${CONV_ID}/files/file-1`)
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(404);
      expect(mockedPrisma.file.delete).not.toHaveBeenCalled();
    });

    it('returns 404 when the file belongs to a different conversation', async () => {
      authedSession();
      mockedPrisma.file.findUnique.mockResolvedValue({
        id: 'file-1',
        storagePath: '/tmp/x',
        conversation: { id: 'other-conv', userId: USER_ID },
      } as never);

      const res = await request(app)
        .delete(`/api/conversations/${CONV_ID}/files/file-1`)
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(404);
      expect(mockedPrisma.file.delete).not.toHaveBeenCalled();
    });

    it('returns 404 when the file does not exist', async () => {
      authedSession();
      mockedPrisma.file.findUnique.mockResolvedValue(null as never);

      const res = await request(app)
        .delete(`/api/conversations/${CONV_ID}/files/missing`)
        .set('Cookie', 'session_id=session-1');

      expect(res.status).toBe(404);
    });
  });
});
