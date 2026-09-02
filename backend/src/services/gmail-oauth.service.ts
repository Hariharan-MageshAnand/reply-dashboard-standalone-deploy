import { google } from 'googleapis';
import type { MailboxProvider } from '@prisma/client';
import { env } from '../config/env.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from './auth.service.js';
import { enqueueMailboxSync } from '../queue/queues.js';

const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

export function createOAuthClient() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

export function buildGoogleMailboxAuthUrl(state: string, loginHint?: string): string {
  if (!env.GOOGLE_OAUTH_READY) {
    throw new AppError(
      'oauth_not_configured',
      'Google OAuth is not configured.',
      400,
      undefined,
      'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or use MAILBOX_MOCK.',
    );
  }

  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state,
    login_hint: loginHint,
  });
}

/** @deprecated use buildGoogleMailboxAuthUrl */
export const buildMailboxAuthUrl = buildGoogleMailboxAuthUrl;

function scopeFlags(scope: string | null | undefined) {
  const scopes = (scope ?? '').split(/[,\s]+/).filter(Boolean);
  return {
    canRead: scopes.some(
      (s) =>
        s.includes('gmail.readonly') ||
        s.includes('gmail.modify') ||
        s.includes('mail.google.com'),
    ),
    canModify: scopes.some((s) => s.includes('gmail.modify') || s.includes('mail.google.com')),
    canSend: scopes.some((s) => s.includes('gmail.send') || s.includes('mail.google.com')),
  };
}

export async function connectMockMailbox(input: {
  workspaceId: string;
  actorId: string;
  email: string;
  displayName?: string;
  provider?: MailboxProvider;
}) {
  const email = input.email.trim().toLowerCase();
  const provider = input.provider ?? 'google';
  const scopes =
    provider === 'microsoft'
      ? 'openid offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send'
      : GMAIL_SCOPES.join(' ');

  const mailbox = await prisma.senderMailbox.upsert({
    where: {
      workspaceId_email: {
        workspaceId: input.workspaceId,
        email,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      provider,
      email,
      displayName: input.displayName ?? email,
      providerSubjectId: `mock-${provider}-${email}`,
      accessTokenEncrypted: encryptSecret('mock-access'),
      refreshTokenEncrypted: encryptSecret('mock-refresh'),
      tokenExpiryAt: new Date(Date.now() + 3600_000),
      scopes,
      health: 'syncing',
      canRead: true,
      canModify: true,
      canSend: true,
      disconnectedAt: null,
      syncState: { create: {} },
    },
    update: {
      provider,
      displayName: input.displayName ?? email,
      providerSubjectId: `mock-${provider}-${email}`,
      accessTokenEncrypted: encryptSecret('mock-access'),
      refreshTokenEncrypted: encryptSecret('mock-refresh'),
      tokenExpiryAt: new Date(Date.now() + 3600_000),
      scopes,
      health: 'syncing',
      canRead: true,
      canModify: true,
      canSend: true,
      disconnectedAt: null,
      lastError: null,
    },
  });

  await prisma.mailboxSyncState.upsert({
    where: { mailboxId: mailbox.id },
    create: { mailboxId: mailbox.id },
    update: {},
  });

  await writeAudit({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'mailbox.connected',
    entityType: 'mailbox',
    entityId: mailbox.id,
    metadata: { email, provider, mock: true },
  });

  // Mock mode: sync inline so local demos work without a separate worker process.
  const { syncMailbox } = await import('./sync.service.js');
  await syncMailbox(mailbox.id, 'initial');
  await enqueueMailboxSync(mailbox.id, 'incremental');
  return mailbox;
}

export async function completeGoogleMailboxConnect(input: {
  workspaceId: string;
  actorId: string;
  code: string;
  expectedEmail?: string | null;
}) {
  if (env.MAILBOX_MOCK) {
    throw new AppError('oauth_failed', 'Use mock mailbox connect in MAILBOX_MOCK mode.', 400);
  }
  if (!env.GOOGLE_OAUTH_READY) {
    throw new AppError('oauth_not_configured', 'Google OAuth is not configured.', 400);
  }

  const client = createOAuthClient();
  const { tokens } = await client.getToken(input.code);
  if (!tokens.access_token) {
    throw new AppError('oauth_failed', 'Google did not return an access token.', 400);
  }
  if (!tokens.refresh_token) {
    throw new AppError(
      'oauth_failed',
      'Google did not return a refresh token.',
      400,
      undefined,
      'Disconnect the app in Google account permissions and reconnect with consent.',
    );
  }

  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();
  const email = profile.data.email?.toLowerCase();
  if (!email) {
    throw new AppError('oauth_failed', 'Could not read the Google account email.', 400);
  }

  if (input.expectedEmail && input.expectedEmail.toLowerCase() !== email) {
    throw new AppError(
      'oauth_failed',
      `You signed in as ${email}, but the connect was locked to ${input.expectedEmail}.`,
      400,
      undefined,
      'Leave the email field empty, or sign in with the exact account it names.',
    );
  }

  const flags = scopeFlags(tokens.scope);
  const mailbox = await prisma.senderMailbox.upsert({
    where: {
      workspaceId_email: {
        workspaceId: input.workspaceId,
        email,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      provider: 'google',
      email,
      displayName: profile.data.name ?? email,
      providerSubjectId: profile.data.id ?? null,
      accessTokenEncrypted: encryptSecret(tokens.access_token),
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      tokenExpiryAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scopes: tokens.scope ?? null,
      health: 'syncing',
      ...flags,
      disconnectedAt: null,
      syncState: { create: {} },
    },
    update: {
      provider: 'google',
      displayName: profile.data.name ?? email,
      providerSubjectId: profile.data.id ?? null,
      accessTokenEncrypted: encryptSecret(tokens.access_token),
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      tokenExpiryAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scopes: tokens.scope ?? null,
      health: 'syncing',
      ...flags,
      disconnectedAt: null,
      lastError: null,
    },
  });

  await prisma.mailboxSyncState.upsert({
    where: { mailboxId: mailbox.id },
    create: { mailboxId: mailbox.id },
    update: {},
  });

  await writeAudit({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'mailbox.connected',
    entityType: 'mailbox',
    entityId: mailbox.id,
    metadata: { email, provider: 'google' },
  });

  await enqueueMailboxSync(mailbox.id, 'initial');
  return mailbox;
}

export async function disconnectMailbox(workspaceId: string, mailboxId: string, actorId: string) {
  const mailbox = await prisma.senderMailbox.findFirst({
    where: { id: mailboxId, workspaceId },
  });
  if (!mailbox) {
    throw new AppError('not_found', 'Mailbox not found.', 404);
  }

  await prisma.senderMailbox.update({
    where: { id: mailbox.id },
    data: {
      health: 'disconnected',
      disconnectedAt: new Date(),
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      canRead: false,
      canModify: false,
      canSend: false,
    },
  });

  await writeAudit({
    workspaceId,
    actorId,
    action: 'mailbox.disconnected',
    entityType: 'mailbox',
    entityId: mailbox.id,
  });
}

export async function getAuthorizedGmailClient(mailboxId: string) {
  const mailbox = await prisma.senderMailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || mailbox.disconnectedAt) {
    throw new AppError('mailbox_revoked', 'Mailbox is disconnected.', 401);
  }
  if (mailbox.provider !== 'google') {
    throw new AppError('invalid_provider', 'Mailbox is not a Google mailbox.', 400);
  }
  if (env.MAILBOX_MOCK) {
    return { mailbox, gmail: null as ReturnType<typeof google.gmail> | null };
  }
  if (!mailbox.refreshTokenEncrypted || !mailbox.accessTokenEncrypted) {
    throw new AppError('mailbox_revoked', 'Mailbox authorization is missing.', 401);
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: decryptSecret(mailbox.accessTokenEncrypted),
    refresh_token: decryptSecret(mailbox.refreshTokenEncrypted),
    expiry_date: mailbox.tokenExpiryAt?.getTime(),
    scope: mailbox.scopes ?? undefined,
  });

  client.on('tokens', async (tokens) => {
    await prisma.senderMailbox.update({
      where: { id: mailbox.id },
      data: {
        accessTokenEncrypted: tokens.access_token
          ? encryptSecret(tokens.access_token)
          : undefined,
        refreshTokenEncrypted: tokens.refresh_token
          ? encryptSecret(tokens.refresh_token)
          : undefined,
        tokenExpiryAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      },
    });
  });

  return { mailbox, gmail: google.gmail({ version: 'v1', auth: client }) };
}
