import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export function csrfTokenEndpoint(_req: Request, res: Response) {
  const token = crypto.randomBytes(32).toString('hex');

  res.cookie('csrf_token', token, {
    httpOnly: false, // Frontend needs to read this
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  res.json({ csrfToken: token });
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    res.status(403).json({ success: false, error: 'Invalid CSRF token' });
    return;
  }

  next();
}
