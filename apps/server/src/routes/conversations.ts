import { Router, type Router as RouterType } from 'express';
import multer from 'multer';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import {
  createConversation,
  listConversations,
  getConversationForUser,
  appendUserMessage,
  appendAssistantMessage,
  renameConversation,
  deleteConversation,
} from '../services/conversation';
import { buildModelMessages } from '../services/context';
import { streamAssistantText, generateAssistantText } from '../services/ai';
import { isSupportedModel, DEFAULT_MODEL_ID } from '../services/models';
import {
  ingestUploadedFile,
  removeFile,
  listFilesForConversation,
  getMaxFileSizeBytes,
} from '../services/files';
import { prisma } from '../lib/db';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getMaxFileSizeBytes() },
});

export const conversationsRouter: RouterType = Router();

conversationsRouter.post(
  '/',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { title } = (req.body ?? {}) as { title?: string };

    const conversation = await createConversation(req.user!.id, title);

    res.status(201).json({ success: true, conversation });
  },
);

conversationsRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  const conversations = await listConversations(req.user!.id);

  res.json({ success: true, conversations });
});

conversationsRouter.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id);
  const conversation = await getConversationForUser(req.user!.id, id);

  if (!conversation) {
    res.status(404).json({ success: false, error: 'Conversation not found' });
    return;
  }

  res.json({ success: true, conversation });
});

conversationsRouter.patch(
  '/:id',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { title } = (req.body ?? {}) as { title?: string };

    if (typeof title !== 'string' || title.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Title is required' });
      return;
    }

    const id = String(req.params.id);
    const conversation = await renameConversation(req.user!.id, id, title.trim());

    if (!conversation) {
      res.status(404).json({ success: false, error: 'Conversation not found' });
      return;
    }

    res.json({ success: true, conversation });
  },
);

conversationsRouter.delete(
  '/:id',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const deleted = await deleteConversation(req.user!.id, id);

    if (!deleted) {
      res.status(404).json({ success: false, error: 'Conversation not found' });
      return;
    }

    res.json({ success: true });
  },
);

function writeSseEvent(res: import('express').Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function uploadSingle(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ success: false, error: 'File too large' });
        return;
      }
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

function publicFile(file: {
  id: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}) {
  return {
    id: file.id,
    conversationId: file.conversationId,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt,
  };
}

conversationsRouter.post(
  '/:id/files',
  csrfProtection,
  requireAuth,
  uploadSingle,
  async (req: AuthenticatedRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'File is required (field name: "file")' });
      return;
    }

    const id = String(req.params.id);
    const outcome = await ingestUploadedFile({
      userId: req.user!.id,
      conversationId: id,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });

    switch (outcome.kind) {
      case 'not-found':
        res.status(404).json({ success: false, error: 'Conversation not found' });
        return;
      case 'unsupported-type':
        res.status(415).json({
          success: false,
          error: 'Unsupported file type. Allowed: pdf, docx, txt',
        });
        return;
      case 'too-large':
        res.status(413).json({ success: false, error: 'File too large' });
        return;
      case 'too-many-files':
        res.status(409).json({
          success: false,
          error: 'Conversation has reached the file limit',
        });
        return;
      case 'extraction-failed':
        res.status(422).json({
          success: false,
          error: 'Could not extract text from file',
        });
        return;
      case 'ok':
        res.status(201).json({ success: true, file: publicFile(outcome.file) });
        return;
    }
  },
);

conversationsRouter.delete(
  '/:id/files/:fileId',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const fileId = String(req.params.fileId);
    const outcome = await removeFile(req.user!.id, id, fileId);

    if (outcome === 'not-found') {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    res.json({ success: true });
  },
);

conversationsRouter.post(
  '/:id/messages',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { content } = (req.body ?? {}) as { content?: string };

    if (typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Message content is required' });
      return;
    }

    const id = String(req.params.id);
    const result = await appendUserMessage(req.user!.id, id, content);

    if (!result) {
      res.status(404).json({ success: false, error: 'Conversation not found' });
      return;
    }

    const { userMessage, history } = result;
    const files = await listFilesForConversation(id);
    const modelMessages = buildModelMessages({
      history,
      files: files.map((f) => ({
        originalName: f.originalName,
        extractedText: f.extractedText,
      })),
    });

    const userSettings = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { preferredModel: true, streamingEnabled: true },
    });
    const userModelId = userSettings?.preferredModel ?? DEFAULT_MODEL_ID;
    const userStreamingDefault = userSettings?.streamingEnabled ?? true;

    const modelOverride = typeof req.query.model === 'string' ? req.query.model : undefined;
    if (modelOverride !== undefined && !isSupportedModel(modelOverride)) {
      res.status(400).json({ success: false, error: 'Invalid model identifier' });
      return;
    }
    const modelId = modelOverride ?? (isSupportedModel(userModelId) ? userModelId : DEFAULT_MODEL_ID);

    const streamParam = req.query.stream;
    const wantsStream =
      streamParam === 'true' ? true : streamParam === 'false' ? false : userStreamingDefault;

    if (!wantsStream) {
      try {
        const assistantText = await generateAssistantText(modelMessages, modelId);
        const assistantMessage = await appendAssistantMessage(id, assistantText);
        res.status(201).json({ success: true, userMessage, assistantMessage });
      } catch (err) {
        console.error('AI generation failed:', err);
        res.status(502).json({ success: false, error: 'AI provider error' });
      }
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    writeSseEvent(res, 'user-message', { userMessage });

    let full = '';
    try {
      const { textStream } = streamAssistantText(modelMessages, modelId);
      for await (const chunk of textStream) {
        full += chunk;
        writeSseEvent(res, 'chunk', { text: chunk });
      }
    } catch (err) {
      console.error('AI stream failed:', err);
      writeSseEvent(res, 'error', { message: 'AI provider error' });
      res.end();
      return;
    }

    const assistantMessage = await appendAssistantMessage(id, full);
    writeSseEvent(res, 'done', { assistantMessage });
    res.end();
  },
);
