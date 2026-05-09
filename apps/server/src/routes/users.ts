import { Router, type Router as RouterType } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import { prisma } from '../lib/db';
import { SUPPORTED_MODELS, isSupportedModel } from '../services/models';

export const usersRouter: RouterType = Router();

function publicModelList() {
  return SUPPORTED_MODELS.map((m) => ({ id: m.id, label: m.label }));
}

usersRouter.get('/settings', requireAuth, async (req: AuthenticatedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { preferredModel: true, streamingEnabled: true },
  });

  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  res.json({
    success: true,
    settings: {
      preferredModel: user.preferredModel,
      streamingEnabled: user.streamingEnabled,
      models: publicModelList(),
    },
  });
});

usersRouter.patch(
  '/settings',
  csrfProtection,
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const { preferredModel, streamingEnabled } = (req.body ?? {}) as {
      preferredModel?: unknown;
      streamingEnabled?: unknown;
    };

    const data: { preferredModel?: string; streamingEnabled?: boolean } = {};

    if (preferredModel !== undefined) {
      if (typeof preferredModel !== 'string' || !isSupportedModel(preferredModel)) {
        res.status(400).json({
          success: false,
          error: 'Invalid model identifier',
          models: publicModelList(),
        });
        return;
      }
      data.preferredModel = preferredModel;
    }

    if (streamingEnabled !== undefined) {
      if (typeof streamingEnabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'streamingEnabled must be a boolean' });
        return;
      }
      data.streamingEnabled = streamingEnabled;
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ success: false, error: 'No settings provided' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      select: { preferredModel: true, streamingEnabled: true },
    });

    res.json({
      success: true,
      settings: {
        preferredModel: updated.preferredModel,
        streamingEnabled: updated.streamingEnabled,
        models: publicModelList(),
      },
    });
  },
);
