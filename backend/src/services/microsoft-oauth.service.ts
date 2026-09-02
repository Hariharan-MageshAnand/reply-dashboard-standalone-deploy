import { env } from '../config/env.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from './auth.service.js';
import { enqueueMailboxSync } from '../queue/queues.js';

const GRAPH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
];

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function tenantBase() {
  return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}`;
}

export function buildMicrosoftMailboxAuthUrl(state: string, loginHint?: string): string {
  if (!env.MICROSOFT_OAUTH_READY) {
    throw new AppError(
      'oauth_not_configured',
      'Microsoft OAuth is not configured.',
      400,
      undefined,
      'Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or use MAILBOX_MOCK.',
    );
  }

  const url = new URL(`${tenantBase()}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', env.MICROSOFT_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.MICROSOFT_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', GRAPH_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'consent');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

function microsoftScopeFlags(scope: string | null | undefined) {
  const scopes = (scope ?? '').split(/[,\s]+/).filter(Boolean);
  const has = (name: string) => scopes.some((s) => s === name || s.endsWith(`/${name}`));
  return {
    canRead: has('Mail.Read') || has('Mail.ReadWrite'),
    canModify: has('Mail.ReadWrite'),
    canSend: has('Mail.Send') || has('Mail.ReadWrite'),
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function exchangeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    code,
    redirect_uri: env.MICROSOFT_REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: GRAPH_SCOPES.join(' '),
  });

  const res = await fetch(`${tenantBase()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AppError('oauth_failed', `Microsoft token exchange failed: ${text}`, 400);
  }
  return (await res.json()) as TokenResponse;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID,
    client_secret: env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: GRAPH_SCOPES.join(' '),
  });

  const res = await fetch(`${tenantBase()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AppError('mailbox_revoked', `Microsoft token refresh failed: ${text}`, 401);
  }
  return (await res.json()) as TokenResponse;
}

export async function completeMicrosoftMailboxConnect(input: {
  workspaceId: string;
  actorId: string;
  code: string;
  expectedEmail?: string | null;
}) {
  if (env.MAILBOX_MOCK) {
    throw new AppError('oauth_failed', 'Use mock mailbox connect in MAILBOX_MOCK mode.', 400);
  }
  if (!env.MICROSOFT_OAUTH_READY) {
    throw new AppError('oauth_not_configured', 'Microsoft OAuth is not configured.', 400);
  }

  const tokens = await exchangeCode(input.code);
  if (!tokens.access_token) {
    throw new AppError('oauth_failed', 'Microsoft did not return an access token.', 400);
  }
  if (!tokens.refresh_token) {
    throw new AppError(
      'oauth_failed',
      'Microsoft did not return a refresh token.',
      400,
      undefined,
      'Ensure offline_access is granted and reconnect with consent.',
    );
  }

  const meRes = await fetch(`${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!meRes.ok) {
    throw new AppError('oauth_failed', 'Could not read the Microsoft account profile.', 400);
  }
  const me = (await meRes.json()) as {
    id?: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  };
  const email = (me.mail || me.userPrincipalName || '').toLowerCase();
  if (!email || !email.includes('@')) {
    throw new AppError('oauth_failed', 'Could not read the Microsoft account email.', 400);
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

  const flags = microsoftScopeFlags(tokens.scope);
  const expiry = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : new Date(Date.now() + 3600_000);

  const mailbox = await prisma.senderMailbox.upsert({
    where: {
      workspaceId_email: {
        workspaceId: input.workspaceId,
        email,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      provider: 'microsoft',
      email,
      displayName: me.displayName ?? email,
      providerSubjectId: me.id ?? null,
      accessTokenEncrypted: encryptSecret(tokens.access_token),
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      tokenExpiryAt: expiry,
      scopes: tokens.scope ?? GRAPH_SCOPES.join(' '),
      health: 'syncing',
      ...flags,
      disconnectedAt: null,
      syncState: { create: {} },
    },
    update: {
      provider: 'microsoft',
      displayName: me.displayName ?? email,
      providerSubjectId: me.id ?? null,
      accessTokenEncrypted: encryptSecret(tokens.access_token),
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      tokenExpiryAt: expiry,
      scopes: tokens.scope ?? GRAPH_SCOPES.join(' '),
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
    metadata: { email, provider: 'microsoft' },
  });

  await enqueueMailboxSync(mailbox.id, 'initial');
  return mailbox;
}

export async function getAuthorizedMicrosoftClient(mailboxId: string) {
  const mailbox = await prisma.senderMailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || mailbox.disconnectedAt) {
    throw new AppError('mailbox_revoked', 'Mailbox is disconnected.', 401);
  }
  if (mailbox.provider !== 'microsoft') {
    throw new AppError('invalid_provider', 'Mailbox is not a Microsoft mailbox.', 400);
  }
  if (env.MAILBOX_MOCK) {
    return { mailbox, accessToken: null as string | null };
  }
  if (!mailbox.refreshTokenEncrypted || !mailbox.accessTokenEncrypted) {
    throw new AppError('mailbox_revoked', 'Mailbox authorization is missing.', 401);
  }

  let accessToken = decryptSecret(mailbox.accessTokenEncrypted);
  const refreshToken = decryptSecret(mailbox.refreshTokenEncrypted);
  const expired =
    !mailbox.tokenExpiryAt || mailbox.tokenExpiryAt.getTime() < Date.now() + 60_000;

  if (expired) {
    const tokens = await refreshAccessToken(refreshToken);
    accessToken = tokens.access_token;
    await prisma.senderMailbox.update({
      where: { id: mailbox.id },
      data: {
        accessTokenEncrypted: encryptSecret(tokens.access_token),
        refreshTokenEncrypted: tokens.refresh_token
          ? encryptSecret(tokens.refresh_token)
          : undefined,
        tokenExpiryAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : undefined,
        scopes: tokens.scope ?? undefined,
      },
    });
  }

  return { mailbox, accessToken };
}

export async function graphFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AppError('provider_error', `Microsoft Graph error: ${text}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
