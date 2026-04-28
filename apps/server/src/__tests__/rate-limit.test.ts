import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRateLimiter } from '../middleware/rate-limit';

function createTestApp(maxAttempts: number, windowMs: number) {
  const app = express();
  app.use(createRateLimiter({ maxAttempts, windowMs }));
  app.post('/test', (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

describe('createRateLimiter', () => {
  it('allows requests under the limit', async () => {
    const app = createTestApp(3, 15 * 60 * 1000);

    const res = await request(app).post('/test');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 429 after exceeding the limit', async () => {
    const app = createTestApp(2, 15 * 60 * 1000);

    await request(app).post('/test');
    await request(app).post('/test');
    const res = await request(app).post('/test');

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Too many requests');
  });

  it('includes retry-after header when rate limited', async () => {
    const app = createTestApp(1, 15 * 60 * 1000);

    await request(app).post('/test');
    const res = await request(app).post('/test');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
