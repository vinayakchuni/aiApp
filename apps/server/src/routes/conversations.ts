import { Router, type Router as RouterType } from 'express';
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
    const modelMessages = buildModelMessages({ history });
    const wantsStream = req.query.stream !== 'false';

    if (!wantsStream) {
      try {
        const assistantText = await generateAssistantText(modelMessages);
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
      const { textStream } = streamAssistantText(modelMessages);
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
