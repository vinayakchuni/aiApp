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
  setConversationMode,
} from '../services/conversation';
import { buildModelMessages } from '../services/context';
import { streamAssistantText, generateAssistantText } from '../services/ai';
import { isSupportedModel, DEFAULT_MODEL_ID } from '../services/models';
import {
  ingestUploadedFile,
  removeFile,
  listFilesForConversation,
  getMaxFileSizeBytes,
  kickoffFileSummarization,
} from '../services/files';
import {
  startResearch,
  processClarifyingAnswer,
  runResearchPipeline,
  getLatestResearchFinal,
  isResearchActiveForUser,
} from '../services/research';
import { generateResearchPdf } from '../services/pdf';
import { prisma } from '../lib/db';
import type { ConversationMode } from '../generated/prisma/enums';

function isConversationMode(value: unknown): value is ConversationMode {
  return value === 'chat' || value === 'research';
}

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
    const { title, mode } = (req.body ?? {}) as { title?: string; mode?: unknown };

    if (mode !== undefined && !isConversationMode(mode)) {
      res.status(400).json({ success: false, error: 'Invalid mode' });
      return;
    }

    const conversation = await createConversation(req.user!.id, {
      title,
      mode: mode as ConversationMode | undefined,
    });

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
    const { title, mode } = (req.body ?? {}) as { title?: string; mode?: unknown };
    const id = String(req.params.id);

    const wantsRename = title !== undefined;
    const wantsModeChange = mode !== undefined;

    if (!wantsRename && !wantsModeChange) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }

    if (wantsRename && (typeof title !== 'string' || title.trim().length === 0)) {
      res.status(400).json({ success: false, error: 'Title is required' });
      return;
    }

    if (wantsModeChange && !isConversationMode(mode)) {
      res.status(400).json({ success: false, error: 'Invalid mode' });
      return;
    }

    let updated: Awaited<ReturnType<typeof renameConversation>> = null;

    if (wantsRename) {
      updated = await renameConversation(req.user!.id, id, (title as string).trim());
      if (!updated) {
        res.status(404).json({ success: false, error: 'Conversation not found' });
        return;
      }
    }

    if (wantsModeChange) {
      const outcome = await setConversationMode(
        req.user!.id,
        id,
        mode as ConversationMode,
      );
      if (outcome.kind === 'not-found') {
        res.status(404).json({ success: false, error: 'Conversation not found' });
        return;
      }
      if (outcome.kind === 'has-messages') {
        res.status(409).json({
          success: false,
          error: 'Cannot change mode on a conversation that already has messages',
          code: 'CONVERSATION_NOT_EMPTY',
        });
        return;
      }
      updated = outcome.conversation;
    }

    res.json({ success: true, conversation: updated });
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
  summary?: string | null;
  createdAt: Date;
}) {
  return {
    id: file.id,
    conversationId: file.conversationId,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    summary: file.summary ?? null,
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
        if (outcome.isResearchConversation) {
          void kickoffFileSummarization(req.user!.id, outcome.file.id).catch(
            (err) => console.error('Background summarization failed:', err),
          );
        }
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
  '/:id/research',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { topic } = (req.body ?? {}) as { topic?: string };

    if (typeof topic !== 'string' || topic.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Research topic is required' });
      return;
    }

    const id = String(req.params.id);
    const outcome = await startResearch(req.user!.id, id, topic.trim());

    switch (outcome.kind) {
      case 'not-found':
        res.status(404).json({ success: false, error: 'Conversation not found' });
        return;
      case 'wrong-mode':
        res.status(409).json({
          success: false,
          error: 'Conversation is not in research mode',
          code: 'NOT_RESEARCH_MODE',
        });
        return;
      case 'wrong-status':
        res.status(409).json({
          success: false,
          error: 'Research has already been started for this conversation',
          code: 'RESEARCH_ALREADY_STARTED',
        });
        return;
      case 'ai-error':
        res.status(502).json({ success: false, error: 'AI provider error' });
        return;
      case 'ok':
        res.status(201).json({
          success: true,
          conversation: outcome.conversation,
          userMessage: outcome.userMessage,
          assistantMessage: outcome.assistantMessage,
        });
        return;
    }
  },
);

conversationsRouter.post(
  '/:id/research/run',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);

    if (isResearchActiveForUser(req.user!.id)) {
      res.status(409).json({
        success: false,
        error:
          'You already have a research task running. Please wait for it to finish before starting another.',
        code: 'RESEARCH_BUSY',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    req.on('close', onClose);

    const outcome = await runResearchPipeline({
      userId: req.user!.id,
      conversationId: id,
      abortSignal: abortController.signal,
      onProgress: (p) => writeSseEvent(res, 'research-progress', p),
    });

    req.off('close', onClose);

    switch (outcome.kind) {
      case 'ok':
        writeSseEvent(res, 'research-complete', {
          conversation: outcome.conversation,
          assistantMessage: outcome.assistantMessage,
        });
        break;
      case 'not-found':
        writeSseEvent(res, 'research-failed', {
          code: 'NOT_FOUND',
          message: 'Conversation not found.',
        });
        break;
      case 'wrong-status':
        writeSseEvent(res, 'research-failed', {
          code: 'WRONG_STATUS',
          message: 'Research is not ready to run on this conversation.',
        });
        break;
      case 'busy':
        writeSseEvent(res, 'research-failed', {
          code: 'RESEARCH_BUSY',
          message:
            'You already have a research task running. Please wait for it to finish before starting another.',
        });
        break;
      case 'insufficient-sources':
        writeSseEvent(res, 'research-failed', {
          code: 'INSUFFICIENT_SOURCES',
          message: `Only ${outcome.sourcesFound} source(s) gathered. Please rephrase the topic and try again.`,
          sourcesFound: outcome.sourcesFound,
        });
        break;
      case 'search-failed':
        writeSseEvent(res, 'research-failed', {
          code: 'SEARCH_FAILED',
          message: outcome.message,
        });
        break;
      case 'ai-error':
        writeSseEvent(res, 'research-failed', {
          code: 'AI_ERROR',
          message: outcome.message,
        });
        break;
      case 'aborted':
        // Client disconnected — no point writing further events.
        break;
    }
    res.end();
  },
);

conversationsRouter.get(
  '/:id/research/pdf',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const record = await getLatestResearchFinal(req.user!.id, id);
    if (!record) {
      res.status(404).json({ success: false, error: 'No research report found' });
      return;
    }
    try {
      const pdf = await generateResearchPdf({
        title: record.topic,
        report: record.report,
      });
      const safeName = record.topic.replace(/[^A-Za-z0-9-_]+/g, '_').slice(0, 60) || 'report';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}.pdf"`,
      );
      res.setHeader('Content-Length', String(pdf.length));
      res.end(pdf);
    } catch (err) {
      console.error('PDF generation failed:', err);
      res.status(500).json({ success: false, error: 'Could not generate PDF' });
    }
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

    const conversationMeta = await prisma.conversation.findUnique({
      where: { id },
      select: { id: true, userId: true, mode: true, researchStatus: true },
    });

    if (conversationMeta && conversationMeta.userId === req.user!.id) {
      if (
        conversationMeta.mode === 'research' &&
        conversationMeta.researchStatus === 'clarifying'
      ) {
        const outcome = await processClarifyingAnswer(req.user!.id, id, content);
        switch (outcome.kind) {
          case 'not-found':
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
          case 'wrong-mode':
          case 'wrong-status':
            res.status(409).json({ success: false, error: 'Invalid research state' });
            return;
          case 'ai-error':
            res.status(502).json({ success: false, error: 'AI provider error' });
            return;
          case 'questions':
          case 'ready':
            res.status(201).json({
              success: true,
              kind: outcome.kind,
              conversation: outcome.conversation,
              userMessage: outcome.userMessage,
              assistantMessage: outcome.assistantMessage,
            });
            return;
        }
      }
      if (
        conversationMeta.mode === 'research' &&
        conversationMeta.researchStatus !== 'idle' &&
        conversationMeta.researchStatus !== 'complete' &&
        conversationMeta.researchStatus !== 'failed'
      ) {
        res.status(409).json({
          success: false,
          error: 'Research is in progress; please wait for it to complete.',
          code: 'RESEARCH_IN_PROGRESS',
        });
        return;
      }
    }

    const result = await appendUserMessage(req.user!.id, id, content);

    if (result.kind === 'not-found') {
      res.status(404).json({ success: false, error: 'Conversation not found' });
      return;
    }
    if (result.kind === 'too-many-messages') {
      res.status(400).json({
        success: false,
        error: 'This conversation has reached the message limit. Start a new conversation to continue.',
        code: 'CONVERSATION_FULL',
      });
      return;
    }

    const { userMessage, history } = result;
    const files = await listFilesForConversation(id);

    let researchContext: Parameters<typeof buildModelMessages>[0]['researchContext'] = null;
    if (
      conversationMeta?.mode === 'research' &&
      conversationMeta.researchStatus === 'complete'
    ) {
      const record = await getLatestResearchFinal(req.user!.id, id);
      if (record) {
        researchContext = {
          topic: record.topic,
          executiveSummary: record.report.executiveSummary,
          keyFindings: record.report.keyFindings,
          sources: record.report.sources.map((s) => ({
            index: s.index,
            title: s.title,
            url: s.url,
          })),
        };
      }
    }

    const modelMessages = buildModelMessages({
      history,
      files: files.map((f) => ({
        originalName: f.originalName,
        extractedText: f.extractedText,
      })),
      researchContext,
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

    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    req.on('close', onClose);

    let full = '';
    try {
      const { textStream } = streamAssistantText(
        modelMessages,
        modelId,
        abortController.signal,
      );
      for await (const chunk of textStream) {
        full += chunk;
        writeSseEvent(res, 'chunk', { text: chunk });
      }
    } catch (err) {
      req.off('close', onClose);
      const isAbort =
        abortController.signal.aborted ||
        (err instanceof Error && err.name === 'AbortError');
      if (isAbort) {
        if (full.length > 0) {
          await appendAssistantMessage(id, full).catch((persistErr) => {
            console.error('Failed to persist partial assistant message:', persistErr);
          });
        }
        res.end();
        return;
      }
      console.error('AI stream failed:', err);
      writeSseEvent(res, 'error', { message: 'AI provider error' });
      res.end();
      return;
    }

    req.off('close', onClose);
    const assistantMessage = await appendAssistantMessage(id, full);
    writeSseEvent(res, 'done', { assistantMessage });
    res.end();
  },
);
