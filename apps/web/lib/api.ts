const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

let csrfToken: string | null = null;

export async function fetchCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;

  const res = await fetch(`${API_URL}/api/auth/csrf-token`, {
    credentials: 'include',
  });
  const data = await res.json();
  csrfToken = data.csrfToken as string;
  return csrfToken!;
}

export async function apiPost(path: string, body?: Record<string, unknown>): Promise<Response> {
  const token = await fetchCsrfToken();

  return fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': token,
    },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function isRateLimited(status: number): boolean {
  return status === 429;
}

export const RATE_LIMIT_MESSAGE = 'Too many requests. Please wait a few minutes and try again.';
