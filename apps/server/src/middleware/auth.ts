import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/db';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    emailVerified: boolean;
    createdAt: Date;
  };
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.session_id;

  if (!sessionId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    res.status(401).json({ success: false, error: 'Session expired or invalid' });
    return;
  }

  req.user = {
    id: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    createdAt: session.user.createdAt,
  };

  next();
}
