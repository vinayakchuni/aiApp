import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { ApiResponse, HealthCheck } from '@ai-app/shared';
import { authRouter } from './routes/auth';
import { conversationsRouter } from './routes/conversations';
import { usersRouter } from './routes/users';

const app: Express = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  const response: ApiResponse<HealthCheck> = {
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
    },
  };
  res.json(response);
});

app.use('/api/auth', authRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/users', usersRouter);

// Return JSON for unhandled errors instead of default HTML
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

export { app };
