import { Router, type Router as RouterType } from 'express';
import bcrypt from 'bcrypt';
import { validatePassword, validateEmail } from '@ai-app/shared';
import { prisma } from '../lib/db';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { generateVerificationToken, validateToken, consumeToken } from '../services/token';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email';

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
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
    },
  });

  // Generate verification token and send email
  const token = await generateVerificationToken({
    userId: user.id,
    type: 'EMAIL_VERIFICATION',
  });

  await sendVerificationEmail({ email: user.email, token });

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
    res.status(403).json({
      success: false,
      error: 'Please verify your email before logging in',
      email: user.email,
    });
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

authRouter.get('/verify-email', async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    res.status(400).json({ success: false, error: 'Verification token is required' });
    return;
  }

  const tokenRecord = await validateToken({ token, type: 'EMAIL_VERIFICATION' });

  if (!tokenRecord) {
    // Check if token exists but is expired
    const existingToken = await prisma.verificationToken.findUnique({ where: { token } });
    if (existingToken && existingToken.expiresAt < new Date()) {
      res.status(400).json({ success: false, error: 'Verification link has expired. Please request a new one.' });
      return;
    }
    res.status(400).json({ success: false, error: 'Verification link is invalid or has expired' });
    return;
  }

  await prisma.user.update({
    where: { id: tokenRecord.userId },
    data: { emailVerified: true },
  });

  await consumeToken(tokenRecord.id);

  res.json({ success: true, message: 'Email verified successfully' });
});

authRouter.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email || !validateEmail(email)) {
    res.status(400).json({ success: false, error: 'Valid email is required' });
    return;
  }

  const normalizedEmail = email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Always return success to prevent email enumeration
  if (!user) {
    res.json({ success: true, message: 'If an account exists with that email, a password reset link has been sent.' });
    return;
  }

  const token = await generateVerificationToken({
    userId: user.id,
    type: 'PASSWORD_RESET',
  });

  await sendPasswordResetEmail({ email: user.email, token });

  res.json({ success: true, message: 'If an account exists with that email, a password reset link has been sent.' });
});

authRouter.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token) {
    res.status(400).json({ success: false, error: 'Reset token is required' });
    return;
  }

  if (!password) {
    res.status(400).json({ success: false, error: 'Password is required' });
    return;
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    res.status(400).json({ success: false, errors: passwordValidation.errors });
    return;
  }

  const tokenRecord = await validateToken({ token, type: 'PASSWORD_RESET' });

  if (!tokenRecord) {
    // Check if token exists but is expired
    const existingToken = await prisma.verificationToken.findUnique({ where: { token } });
    if (existingToken && existingToken.type === 'PASSWORD_RESET' && existingToken.expiresAt < new Date()) {
      res.status(400).json({ success: false, error: 'Reset link has expired. Please request a new one.' });
      return;
    }
    res.status(400).json({ success: false, error: 'Reset link is invalid or has expired' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.user.update({
    where: { id: tokenRecord.userId },
    data: { passwordHash },
  });

  // Invalidate all sessions for this user
  await prisma.session.deleteMany({
    where: { userId: tokenRecord.userId },
  });

  await consumeToken(tokenRecord.id);

  res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
});

authRouter.post('/resend-verification', async (req, res) => {
  const { email } = req.body;

  if (!email || !validateEmail(email)) {
    res.status(400).json({ success: false, error: 'Valid email is required' });
    return;
  }

  const normalizedEmail = email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Always return success to prevent email enumeration
  if (!user || user.emailVerified) {
    res.json({ success: true, message: 'If an account exists with that email, a verification link has been sent.' });
    return;
  }

  const token = await generateVerificationToken({
    userId: user.id,
    type: 'EMAIL_VERIFICATION',
  });

  await sendVerificationEmail({ email: user.email, token });

  res.json({ success: true, message: 'If an account exists with that email, a verification link has been sent.' });
});
