import express, { type Express } from 'express';
import cors from 'cors';
import type { ApiResponse, HealthCheck } from '@ai-app/shared';
import { authRouter } from './routes/auth';

const app: Express = express();

app.use(cors());
app.use(express.json());

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

export { app };
