import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { AppError, sendError } from './lib/errors.js';
import { authRouter } from './routes/auth.routes.js';
import {
  mailboxRouter,
  googleOauthCallbackRouter,
  microsoftOauthCallbackRouter,
} from './routes/mailbox.routes.js';
import { conversationRouter } from './routes/conversation.routes.js';
import { approvalRouter } from './routes/approval.routes.js';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
    }),
  );
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'reply-dashboard-api',
      timestamp: new Date().toISOString(),
      mocks: { mailbox: env.MAILBOX_MOCK },
      oauth: {
        google: env.GOOGLE_OAUTH_READY,
        microsoft: env.MICROSOFT_OAUTH_READY,
      },
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/mailboxes', mailboxRouter);
  app.use('/api/oauth/google', googleOauthCallbackRouter);
  app.use('/api/oauth/microsoft', microsoftOauthCallbackRouter);
  app.use('/api/conversations', conversationRouter);
  app.use('/api/approvals', approvalRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      sendError(res, err);
      return;
    }
    if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ZodError') {
      sendError(
        res,
        new AppError('validation_error', 'Invalid request payload.', 400),
      );
      return;
    }
    sendError(res, err as Error);
  });

  return app;
}
