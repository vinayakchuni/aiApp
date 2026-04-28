import { describe, it, expect } from 'vitest';
import { validatePassword, validateEmail } from '../auth';

describe('validatePassword', () => {
  it('accepts a valid password', () => {
    const result = validatePassword('MyPass1!');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects password shorter than 8 characters', () => {
    const result = validatePassword('Ab1!');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must be at least 8 characters');
  });

  it('rejects password without a number', () => {
    const result = validatePassword('MyPasswo!');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must contain at least 1 number');
  });

  it('rejects password without a special character', () => {
    const result = validatePassword('MyPassw0rd');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Password must contain at least 1 special character');
  });

  it('returns multiple errors for a completely invalid password', () => {
    const result = validatePassword('abc');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts various special characters', () => {
    expect(validatePassword('Passw0rd@').valid).toBe(true);
    expect(validatePassword('Passw0rd#').valid).toBe(true);
    expect(validatePassword('Passw0rd$').valid).toBe(true);
    expect(validatePassword('Passw0rd!').valid).toBe(true);
  });
});

describe('validateEmail', () => {
  it('accepts a valid email', () => {
    expect(validateEmail('user@example.com')).toBe(true);
  });

  it('accepts email with subdomain', () => {
    expect(validateEmail('user@sub.example.com')).toBe(true);
  });

  it('rejects email without @', () => {
    expect(validateEmail('userexample.com')).toBe(false);
  });

  it('rejects email without domain', () => {
    expect(validateEmail('user@')).toBe(false);
  });

  it('rejects email without local part', () => {
    expect(validateEmail('@example.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateEmail('')).toBe(false);
  });

  it('rejects email with spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false);
  });
});
