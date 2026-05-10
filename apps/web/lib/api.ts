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

export async function apiPost(
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const token = await fetchCsrfToken();

  return fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': token,
    },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

export async function apiGet(path: string): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: 'GET',
    credentials: 'include',
  });
}

export async function apiPatch(path: string, body?: Record<string, unknown>): Promise<Response> {
  const token = await fetchCsrfToken();

  return fetch(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': token,
    },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiDelete(path: string): Promise<Response> {
  const token = await fetchCsrfToken();

  return fetch(`${API_URL}${path}`, {
    method: 'DELETE',
    headers: {
      'x-csrf-token': token,
    },
    credentials: 'include',
  });
}

export async function apiUpload(path: string, file: File): Promise<Response> {
  const token = await fetchCsrfToken();
  const form = new FormData();
  form.append('file', file);

  return fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'x-csrf-token': token,
    },
    credentials: 'include',
    body: form,
  });
}

export function isRateLimited(status: number): boolean {
  return status === 429;
}

export const RATE_LIMIT_MESSAGE = 'Too many requests. Please wait a few minutes and try again.';

export interface SseEvent<T = unknown> {
  event: string;
  data: T;
}

export async function* readSseEvents<T = unknown>(
  response: Response,
): AsyncGenerator<SseEvent<T>> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      yield { event, data: JSON.parse(dataLines.join('\n')) as T };
    }
  }
}
