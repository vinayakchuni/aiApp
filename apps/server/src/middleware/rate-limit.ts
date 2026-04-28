import rateLimit from 'express-rate-limit';

interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
}

export function createRateLimiter({ maxAttempts, windowMs }: RateLimiterOptions) {
  return rateLimit({
    windowMs,
    max: maxAttempts,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Please try again later.' },
  });
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const loginLimiter = createRateLimiter({ maxAttempts: 5, windowMs: FIFTEEN_MINUTES });
export const registerLimiter = createRateLimiter({ maxAttempts: 3, windowMs: FIFTEEN_MINUTES });
export const forgotPasswordLimiter = createRateLimiter({ maxAttempts: 3, windowMs: FIFTEEN_MINUTES });
