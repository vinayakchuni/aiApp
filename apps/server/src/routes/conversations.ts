import { Router, type Router as RouterType } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import {
  createConversation,
  listConversations,
  getConversationForUser,
  appendUserAndEchoMessages,
} from '../services/conversation';

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
    const result = await appendUserAndEchoMessages(req.user!.id, id, content);

    if (!result) {
      res.status(404).json({ success: false, error: 'Conversation not found' });
      return;
    }

    res.status(201).json({
      success: true,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
    });
  },
);
