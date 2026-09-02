import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  buildGoogleMailboxAuthUrl,
  completeGoogleMailboxConnect,
  connectMockMailbox,
  disconnectMailbox,
} from '../services/gmail-oauth.service.js';
import {
  buildMicrosoftMailboxAuthUrl,
  completeMicrosoftMailboxConnect,
} from '../services/microsoft-oauth.service.js';
import { listMailboxes } from '../services/conversation.service.js';
import { enqueueMailboxSync } from '../queue/queues.js';
import { syncMailbox } from '../services/sync.service.js';
import { requireAuth } from '../types/auth.js';
import { param } from '../lib/params.js';
import type { Prisma } from '@prisma/client';

export const mailboxRouter = Router();
export const googleOauthCallbackRouter = Router();
export const microsoftOauthCallbackRouter = Router();
/** @deprecated alias */
export const oauthCallbackRouter = googleOauthCallbackRouter;

const providerSchema = z.enum(['google', 'microsoft']).default('google');

mailboxRouter.get(
  '/',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const items = await listMailboxes(auth.workspaceId);
    res.json({ items });
  }),
);

mailboxRouter.post(
  '/connect/start',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        emailHint: z.string().email().optional(),
        provider: providerSchema,
      })
      .parse(req.body ?? {});

    const state = nanoid(24);
    await prisma.idempotencyKey.create({
      data: {
        key: `oauth-state-${state}`,
        scope: 'oauth',
        resultJson: {
          workspaceId: auth.workspaceId,
          actorId: auth.userId,
          emailHint: body.emailHint ?? null,
          provider: body.provider,
        } as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });

    if (env.MAILBOX_MOCK) {
      res.json({
        mock: true,
        provider: body.provider,
        state,
        authorizeUrl: null,
        message: 'Mock mode: POST /api/mailboxes/connect/mock with an email and provider.',
      });
      return;
    }

    if (body.provider === 'microsoft') {
      const authorizeUrl = buildMicrosoftMailboxAuthUrl(state, body.emailHint);
      res.json({ mock: false, provider: 'microsoft', state, authorizeUrl });
      return;
    }

    const authorizeUrl = buildGoogleMailboxAuthUrl(state, body.emailHint);
    res.json({ mock: false, provider: 'google', state, authorizeUrl });
  }),
);

mailboxRouter.post(
  '/connect/mock',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    if (!env.MAILBOX_MOCK) {
      throw new AppError('forbidden', 'Mock mailbox connect is disabled.', 403);
    }
    const body = z
      .object({
        email: z.string().email(),
        displayName: z.string().optional(),
        provider: providerSchema,
      })
      .parse(req.body);

    const mailbox = await connectMockMailbox({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      email: body.email,
      displayName: body.displayName,
      provider: body.provider,
    });
    res.status(201).json({
      id: mailbox.id,
      email: mailbox.email,
      provider: mailbox.provider,
    });
  }),
);

async function handleOAuthCallback(
  provider: 'google' | 'microsoft',
  req: Parameters<Parameters<typeof asyncHandler>[0]>[0],
  res: Parameters<Parameters<typeof asyncHandler>[0]>[1],
) {
  const query = z
    .object({
      code: z.string().optional(),
      state: z.string(),
      error: z.string().optional(),
    })
    .parse(req.query);

  if (query.error) {
    res.redirect(`${env.FRONTEND_URL}/settings/mailboxes?error=${encodeURIComponent(query.error)}`);
    return;
  }
  if (!query.code) {
    res.redirect(`${env.FRONTEND_URL}/settings/mailboxes?error=missing_code`);
    return;
  }

  const stateRow = await prisma.idempotencyKey.findUnique({
    where: { key: `oauth-state-${query.state}` },
  });
  if (!stateRow || stateRow.expiresAt < new Date()) {
    res.redirect(`${env.FRONTEND_URL}/settings/mailboxes?error=invalid_state`);
    return;
  }
  const meta = stateRow.resultJson as {
    workspaceId: string;
    actorId: string;
    emailHint?: string | null;
    provider?: string;
  };

  try {
    if (provider === 'microsoft' || meta.provider === 'microsoft') {
      await completeMicrosoftMailboxConnect({
        workspaceId: meta.workspaceId,
        actorId: meta.actorId,
        code: query.code,
        expectedEmail: meta.emailHint,
      });
    } else {
      await completeGoogleMailboxConnect({
        workspaceId: meta.workspaceId,
        actorId: meta.actorId,
        code: query.code,
        expectedEmail: meta.emailHint,
      });
    }
  } catch (error) {
    // Land the operator back in the app with a readable message — never a raw
    // JSON error page in the browser.
    const message =
      error instanceof AppError
        ? [error.message, error.recovery].filter(Boolean).join(' ')
        : 'Mailbox connect failed. Try again.';
    console.error(`${provider} mailbox connect failed:`, message);
    res.redirect(`${env.FRONTEND_URL}/settings/mailboxes?error=${encodeURIComponent(message)}`);
    return;
  }

  await prisma.idempotencyKey.delete({ where: { id: stateRow.id } }).catch(() => undefined);
  res.redirect(`${env.FRONTEND_URL}/settings/mailboxes?connected=1`);
}

googleOauthCallbackRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    await handleOAuthCallback('google', req, res);
  }),
);

microsoftOauthCallbackRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    await handleOAuthCallback('microsoft', req, res);
  }),
);

mailboxRouter.post(
  '/:mailboxId/sync',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const mailboxId = param(req, 'mailboxId');
    const mailbox = await prisma.senderMailbox.findFirst({
      where: { id: mailboxId, workspaceId: auth.workspaceId, disconnectedAt: null },
      include: { syncState: true },
    });
    if (!mailbox) throw new AppError('not_found', 'Mailbox not found.', 404);
    await prisma.mailboxSyncState.upsert({
      where: { mailboxId: mailbox.id },
      create: { mailboxId: mailbox.id },
      update: {},
    });
    const body = z.object({ full: z.boolean().optional() }).parse(req.body ?? {});
    // full=true re-walks the whole initial window (e.g. after widening it).
    const mode = body.full || !mailbox.syncState?.initialSyncDone ? 'initial' : 'incremental';
    if (env.MAILBOX_MOCK) {
      await syncMailbox(mailbox.id, mode);
    } else {
      await enqueueMailboxSync(mailbox.id, mode);
    }
    res.json({ queued: true });
  }),
);

mailboxRouter.delete(
  '/:mailboxId',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    await disconnectMailbox(auth.workspaceId, param(req, 'mailboxId'), auth.userId);
    res.status(204).end();
  }),
);
