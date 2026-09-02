import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export interface LocalIdentity {
  authKey: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  profilePhotoUrl: string | null;
}

function signingKey(): Buffer {
  return Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');
}

/** Issue a signed local session token for simple email identity. */
export function issueLocalSessionToken(email: string): string {
  const normalized = email.trim().toLowerCase();
  const payload = Buffer.from(
    JSON.stringify({
      email: normalized,
      iat: Date.now(),
    }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  return `local.${payload}.${sig}`;
}

export function issueLocalSession(input: {
  email: string;
  name?: string;
}): { token: string; identity: LocalIdentity } {
  const email = input.email.trim().toLowerCase();
  const token = issueLocalSessionToken(email);
  const identity = resolveLocalIdentity(token);
  if (input.name?.trim()) {
    const name = input.name.trim();
    const [first, ...rest] = name.split(/\s+/);
    identity.firstName = first || name;
    identity.lastName = rest.length ? rest.join(' ') : null;
    identity.fullName = name;
  }
  return { token, identity };
}

export function resolveLocalIdentity(token: string): LocalIdentity {
  if (!token.startsWith('local.') && !token.startsWith('mock_')) {
    throw new AppError(
      'unauthorized',
      'Invalid session. Sign in again.',
      401,
      undefined,
      'Sign in with your email.',
    );
  }

  // Backward-compatible mock tokens from earlier builds
  if (token.startsWith('mock_')) {
    const email = token.replace(/^mock_/, '').includes('@')
      ? token.replace(/^mock_/, '').toLowerCase()
      : 'hari@emsoft.com';
    const name = email.split('@')[0] ?? 'User';
    return {
      authKey: `local:${email}`,
      email,
      firstName: name,
      lastName: null,
      fullName: name,
      profilePhotoUrl: null,
    };
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'local') {
    throw new AppError('unauthorized', 'Invalid session token.', 401);
  }
  const [, payload, sig] = parts;
  const expected = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('unauthorized', 'Invalid session signature.', 401);
  }

  let parsed: { email?: string; iat?: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
      iat?: number;
    };
  } catch {
    throw new AppError('unauthorized', 'Corrupt session token.', 401);
  }

  const email = parsed.email?.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new AppError('unauthorized', 'Session is missing an email.', 401);
  }

  // 30-day session
  if (parsed.iat && Date.now() - parsed.iat > 30 * 24 * 3600_000) {
    throw new AppError('unauthorized', 'Session expired. Sign in again.', 401);
  }

  const name = email.split('@')[0] ?? 'User';
  return {
    authKey: `local:${email}`,
    email,
    firstName: name,
    lastName: null,
    fullName: name,
    profilePhotoUrl: null,
  };
}
