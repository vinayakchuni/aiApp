import { Router, type Router as RouterType } from 'express';
import bcrypt from 'bcrypt';
import { validatePassword, validateEmail } from '@ai-app/shared';
import { prisma } from '../lib/db';

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
