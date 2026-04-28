// Auth request/response types
export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface AuthResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface ResendVerificationRequest {
  email: string;
}

export interface VerifyEmailResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface UserResponse {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

// Password validation
export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }
  if (!/\d/.test(password)) {
    errors.push('Password must contain at least 1 number');
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    errors.push('Password must contain at least 1 special character');
  }

  return { valid: errors.length === 0, errors };
}

// Email validation
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
