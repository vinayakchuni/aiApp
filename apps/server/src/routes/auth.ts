import { Router, type Router as RouterType } from 'express';
import bcrypt from 'bcrypt';
import { validatePassword, validateEmail } from '@ai-app/shared';
import { prisma } from '../lib/db';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export const authRouter: RouterType = Router();

authRouter.post('/register', async (req, res) => {
  const { email, password } = req.body;

  // Validate email
  if (!email || !validateEmail(email)) {
    res.status(400).json({ success: false, error: 'Invalid email address' });
    return;
  }

  // Validate password
  const passwordValidation = validatePassword(password || '');
  if (!passwordValidation.valid) {
    res.status(400).json({ success: false, errors: passwordValidation.errors });
    return;
  }

  const normalizedEmail = email.toLowerCase();

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    res.status(409).json({ success: false, error: 'An account with this email already exists' });
    return;
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);

  // Create user
  await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
    },
  });

  res.status(201).json({ success: true, message: 'Registration successful. Please verify your email.' });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, error: 'Email and password are required' });
    return;
  }

  const normalizedEmail = email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    res.status(401).json({ success: false, error: 'Invalid email or password' });
    return;
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    res.status(401).json({ success: false, error: 'Invalid email or password' });
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({ success: false, error: 'Please verify your email before logging in' });
    return;
  }

  // Create session
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
    },
  });

  // Set session cookie
  res.cookie('session_id', session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_DURATION_MS,
    path: '/',
  });

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt.toISOString(),
    },
  });
});

authRouter.post('/logout', requireAuth, async (req: AuthenticatedRequest, res) => {
  const sessionId = req.cookies?.session_id;

  await prisma.session.delete({
    where: { id: sessionId },
  });

  res.clearCookie('session_id', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  res.json({ success: true, message: 'Logged out successfully' });
});

authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({
    success: true,
    user: {
      id: req.user!.id,
      email: req.user!.email,
      emailVerified: req.user!.emailVerified,
      createdAt: req.user!.createdAt.toISOString(),
    },
  });
});
