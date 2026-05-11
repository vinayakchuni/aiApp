import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db', () => ({
  prisma: {
    file: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../services/ai', () => ({
  defaultModel: vi.fn(() => 'mock-model'),
  generateAssistantText: vi.fn(),
}));

import { prisma } from '../lib/db';
import { generateAssistantText } from '../services/ai';
import { summarizeFile, buildSummarizePrompt } from '../services/summarize';

const mockedPrisma = vi.mocked(prisma);
const mockedGenerate = vi.mocked(generateAssistantText);

describe('buildSummarizePrompt', () => {
  it('truncates very long input but keeps the document name', () => {
    const text = 'a'.repeat(200_000);
    const messages = buildSummarizePrompt('notes.txt', text);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('notes.txt');
    expect(messages[1].content).toContain('truncated for summarization');
    expect(messages[1].content.length).toBeLessThan(text.length);
  });

  it('keeps short input intact', () => {
    const messages = buildSummarizePrompt('short.txt', 'small body');
    expect(messages[1].content).toContain('small body');
    expect(messages[1].content).not.toContain('truncated');
  });
});

describe('summarizeFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not-found when the file row is missing', async () => {
    mockedPrisma.file.findUnique.mockResolvedValue(null as never);
    const out = await summarizeFile('missing');
    expect(out).toEqual({ kind: 'not-found' });
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('returns already-summarized when summary is set and force is false', async () => {
    mockedPrisma.file.findUnique.mockResolvedValue({
      id: 'f-1',
      originalName: 'a.txt',
      extractedText: 'body',
      summary: 'existing summary',
    } as never);
    const out = await summarizeFile('f-1');
    expect(out).toEqual({ kind: 'already-summarized' });
    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(mockedPrisma.file.update).not.toHaveBeenCalled();
  });

  it('regenerates when force=true is set', async () => {
    mockedPrisma.file.findUnique.mockResolvedValue({
      id: 'f-1',
      originalName: 'a.txt',
      extractedText: 'body',
      summary: 'old',
    } as never);
    mockedGenerate.mockResolvedValue('fresh summary');
    mockedPrisma.file.update.mockResolvedValue({} as never);

    const out = await summarizeFile('f-1', { force: true });
    expect(out).toEqual({ kind: 'ok', summary: 'fresh summary' });
    expect(mockedPrisma.file.update).toHaveBeenCalledWith({
      where: { id: 'f-1' },
      data: { summary: 'fresh summary' },
    });
  });

  it('writes a summary on the happy path', async () => {
    mockedPrisma.file.findUnique.mockResolvedValue({
      id: 'f-1',
      originalName: 'a.txt',
      extractedText: 'document body',
      summary: null,
    } as never);
    mockedGenerate.mockResolvedValue('  Generated summary.  ');
    mockedPrisma.file.update.mockResolvedValue({} as never);

    const out = await summarizeFile('f-1', { preferredModel: 'openai:gpt-4o-mini' });
    expect(out).toEqual({ kind: 'ok', summary: 'Generated summary.' });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.file.update).toHaveBeenCalledWith({
      where: { id: 'f-1' },
      data: { summary: 'Generated summary.' },
    });
  });

  it('returns ai-error when the LLM throws and does not write a partial summary', async () => {
    mockedPrisma.file.findUnique.mockResolvedValue({
      id: 'f-1',
      originalName: 'a.txt',
      extractedText: 'body',
      summary: null,
    } as never);
    mockedGenerate.mockRejectedValue(new Error('llm down'));

    const out = await summarizeFile('f-1');
    expect(out.kind).toBe('ai-error');
    expect(mockedPrisma.file.update).not.toHaveBeenCalled();
  });

  it('persists an empty summary when extracted text is empty', async () => {
    mockedPrisma.file.findUnique.mockResolvedValue({
      id: 'f-1',
      originalName: 'a.txt',
      extractedText: '   ',
      summary: null,
    } as never);
    mockedPrisma.file.update.mockResolvedValue({} as never);

    const out = await summarizeFile('f-1');
    expect(out).toEqual({ kind: 'ok', summary: '' });
    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(mockedPrisma.file.update).toHaveBeenCalledWith({
      where: { id: 'f-1' },
      data: { summary: '' },
    });
  });

  it('falls back to the default model when preferredModel is unsupported', async () => {
    mockedPrisma.file.findUnique.mockResolvedValue({
      id: 'f-1',
      originalName: 'a.txt',
      extractedText: 'body',
      summary: null,
    } as never);
    mockedGenerate.mockResolvedValue('summary');
    mockedPrisma.file.update.mockResolvedValue({} as never);

    await summarizeFile('f-1', { preferredModel: 'not-a-real-model' });
    const callArgs = mockedGenerate.mock.calls[0];
    expect(typeof callArgs[1]).toBe('string');
    expect(callArgs[1]).not.toBe('not-a-real-model');
  });
});
