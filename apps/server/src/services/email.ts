import { Resend } from 'resend';

let resend: Resend;

function getResendClient() {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@example.com';
const APP_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export async function sendVerificationEmail({ email, token }: { email: string; token: string }) {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;

  await getResendClient().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'Verify your email address',
    text: `Welcome! Please verify your email address by clicking the link below:\n\n${verifyUrl}\n\nThis link will expire in 24 hours.\n\nIf you did not create an account, you can safely ignore this email.`,
  });
}

export async function sendPasswordResetEmail({ email, token }: { email: string; token: string }) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  await getResendClient().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: 'Reset your password',
    text: `You requested a password reset. Click the link below to set a new password:\n\n${resetUrl}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, you can safely ignore this email.`,
  });
}
