'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { apiPost, isRateLimited, RATE_LIMIT_MESSAGE } from '../../lib/api';

type VerifyState = 'check-email' | 'verifying' | 'success' | 'error' | 'expired';

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const emailParam = searchParams.get('email');

  const [state, setState] = useState<VerifyState>(token ? 'verifying' : 'check-email');
  const [error, setError] = useState('');
  const [resendEmail, setResendEmail] = useState(emailParam || '');
  const [resendSent, setResendSent] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);

  const verifyToken = useCallback(async (verificationToken: string) => {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`,
        { credentials: 'include' },
      );

      const data = await res.json();

      if (res.ok) {
        setState('success');
      } else if (data.error?.includes('expired')) {
        setState('expired');
        setError(data.error);
      } else {
        setState('error');
        setError(data.error || 'Verification failed');
      }
    } catch {
      setState('error');
      setError('Network error. Please try again.');
    }
  }, []);

  useEffect(() => {
    if (token) {
      verifyToken(token);
    }
  }, [token, verifyToken]);

  async function handleResend() {
    if (!resendEmail) return;

    setResendLoading(true);
    try {
      const res = await apiPost('/api/auth/resend-verification', { email: resendEmail });

      if (isRateLimited(res.status)) {
        setError(RATE_LIMIT_MESSAGE);
        return;
      }

      if (res.ok) {
        setResendSent(true);
      }
    } catch {
      setError('Failed to resend verification email.');
    } finally {
      setResendLoading(false);
    }
  }

  if (state === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
            <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Email verified!</h1>
          <p className="text-gray-600">
            Your email has been verified successfully. You can now sign in to your account.
          </p>
          <Link
            href="/login"
            className="inline-block rounded-md bg-blue-600 px-6 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (state === 'verifying') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <svg className="mx-auto h-10 w-10 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <h1 className="text-2xl font-bold text-gray-900">Verifying your email...</h1>
          <p className="text-gray-600">Please wait while we verify your email address.</p>
        </div>
      </div>
    );
  }

  if (state === 'error' || state === 'expired') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">
            {state === 'expired' ? 'Link expired' : 'Verification failed'}
          </h1>
          <p className="text-gray-600">{error}</p>

          <div className="space-y-3">
            <p className="text-sm text-gray-500">Enter your email to receive a new verification link:</p>
            <input
              type="email"
              value={resendEmail}
              onChange={(e) => setResendEmail(e.target.value)}
              placeholder="you@example.com"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {resendSent ? (
              <p className="text-sm text-green-600">Verification email sent! Check your inbox.</p>
            ) : (
              <button
                onClick={handleResend}
                disabled={resendLoading || !resendEmail}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resendLoading ? 'Sending...' : 'Resend verification email'}
              </button>
            )}
          </div>

          <Link href="/login" className="inline-block text-sm font-medium text-blue-600 hover:text-blue-500">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  // Default: check-email state (shown after registration)
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
          <svg className="h-8 w-8 text-blue-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Check your email</h1>
        <p className="text-gray-600">
          We&apos;ve sent you a verification link. Please check your inbox and click the link to verify your account.
        </p>
        <p className="text-sm text-gray-500">
          The link will expire in 24 hours.
        </p>

        {resendEmail && !resendSent && (
          <button
            onClick={handleResend}
            disabled={resendLoading}
            className="text-sm font-medium text-blue-600 hover:text-blue-500 disabled:opacity-50"
          >
            {resendLoading ? 'Sending...' : 'Didn\'t receive an email? Resend'}
          </button>
        )}
        {resendSent && (
          <p className="text-sm text-green-600">Verification email sent! Check your inbox.</p>
        )}

        <Link href="/login" className="inline-block text-sm font-medium text-blue-600 hover:text-blue-500">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
