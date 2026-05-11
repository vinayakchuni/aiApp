import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { prisma } from '../lib/db';
import { detectExtension, extractText, SUPPORTED_EXTENSIONS } from './extract';
import { summarizeFile } from './summarize';

const DEFAULT_UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const DEFAULT_MAX_FILES = 2;
const DEFAULT_MAX_FILE_SIZE_MB = 5;

export function getUploadDir(): string {
  return process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR;
}

export function getMaxFiles(): number {
  const raw = process.env.MAX_FILES_PER_CONVERSATION;
  if (!raw) return DEFAULT_MAX_FILES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILES;
}

export function getMaxFileSizeBytes(): number {
  const raw = process.env.MAX_FILE_SIZE_MB;
  const mb = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_FILE_SIZE_MB;
  const safe = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_FILE_SIZE_MB;
  return safe * 1024 * 1024;
}

export function getSupportedExtensions(): readonly string[] {
  return SUPPORTED_EXTENSIONS;
}

export type UploadOutcome =
  | {
      kind: 'ok';
      file: Awaited<ReturnType<typeof prisma.file.create>>;
      isResearchConversation: boolean;
    }
  | { kind: 'not-found' }
  | { kind: 'unsupported-type' }
  | { kind: 'too-large' }
  | { kind: 'too-many-files' }
  | { kind: 'extraction-failed' };

export interface UploadInput {
  userId: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
}

export async function ingestUploadedFile(input: UploadInput): Promise<UploadOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: { id: true, userId: true, mode: true },
  });
  if (!conversation || conversation.userId !== input.userId) {
    return { kind: 'not-found' };
  }

  const extension = detectExtension(input.originalName, input.mimeType);
  if (!extension) {
    return { kind: 'unsupported-type' };
  }

  if (input.size > getMaxFileSizeBytes()) {
    return { kind: 'too-large' };
  }

  const existingCount = await prisma.file.count({
    where: { conversationId: input.conversationId },
  });
  if (existingCount >= getMaxFiles()) {
    return { kind: 'too-many-files' };
  }

  let extractedText: string;
  try {
    extractedText = await extractText(input.buffer, extension);
  } catch (err) {
    console.error('Text extraction failed:', err);
    return { kind: 'extraction-failed' };
  }

  const dir = getUploadDir();
  await fs.mkdir(dir, { recursive: true });
  const storedName = `${crypto.randomUUID()}.${extension}`;
  const storagePath = path.join(dir, storedName);
  await fs.writeFile(storagePath, input.buffer);

  const file = await prisma.file.create({
    data: {
      conversationId: input.conversationId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      size: input.size,
      extractedText,
      storagePath,
    },
  });

  return {
    kind: 'ok',
    file,
    isResearchConversation: conversation.mode === 'research',
  };
}

export async function kickoffFileSummarization(
  userId: string,
  fileId: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferredModel: true },
  });
  await summarizeFile(fileId, { preferredModel: user?.preferredModel });
}

export type DeleteOutcome = 'ok' | 'not-found';

export async function removeFile(
  userId: string,
  conversationId: string,
  fileId: string,
): Promise<DeleteOutcome> {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      storagePath: true,
      conversation: { select: { id: true, userId: true } },
    },
  });

  if (
    !file ||
    file.conversation.id !== conversationId ||
    file.conversation.userId !== userId
  ) {
    return 'not-found';
  }

  await prisma.file.delete({ where: { id: fileId } });
  await fs.unlink(file.storagePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') {
      console.error('Failed to remove uploaded file from disk:', err);
    }
  });

  return 'ok';
}

export async function listFilesForConversation(conversationId: string) {
  return prisma.file.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
}
