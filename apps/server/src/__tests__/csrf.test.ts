import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { csrfProtection, csrfTokenEndpoint } from '../middleware/csrf';

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.get('/api/auth/csrf-token', csrfTokenEndpoint);
  app.post('/test', csrfProtection, (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

describe('CSRF protection', () => {
  it('rejects POST requests without a CSRF token', async () => {
    const app = createTestApp();

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('CSRF');
  });

  it('rejects POST requests when header token does not match cookie', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/test')
      .set('Cookie', 'csrf_token=cookie-value')
      .set('x-csrf-token', 'different-value')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('allows POST requests when header token matches cookie', async () => {
    const app = createTestApp();

    // First get a CSRF token
    const tokenRes = await request(app).get('/api/auth/csrf-token');
    const csrfCookie = tokenRes.headers['set-cookie']?.find((c: string) => c.startsWith('csrf_token='));
    const csrfToken = tokenRes.body.csrfToken;

    expect(csrfToken).toBeDefined();
    expect(csrfCookie).toBeDefined();

    // Use it in a POST request
    const res = await request(app)
      .post('/test')
      .set('Cookie', csrfCookie!)
      .set('x-csrf-token', csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('csrf-token endpoint sets a csrf_token cookie', async () => {
    const app = createTestApp();

    const res = await request(app).get('/api/auth/csrf-token');

    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toBeDefined();
    expect(res.body.csrfToken.length).toBeGreaterThan(0);
    const csrfCookie = res.headers['set-cookie']?.find((c: string) => c.startsWith('csrf_token='));
    expect(csrfCookie).toBeDefined();
  });
});
