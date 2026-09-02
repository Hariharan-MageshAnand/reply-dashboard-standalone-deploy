import type { MessageDirection } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { getAuthorizedGmailClient } from './gmail-oauth.service.js';
import {
  getAuthorizedMicrosoftClient,
  graphFetch,
} from './microsoft-oauth.service.js';
import { env } from '../config/env.js';
import {
  upsertConversationMessage,
  type ParticipantInput,
} from './message-store.service.js';
import { reconcilePendingSends } from './send.service.js';
import { enqueueClassification } from '../queue/queues.js';

function decodeBody(data?: string | null): string {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function headerMap(headers: Array<{ name?: string | null; value?: string | null }> = []) {
  const map = new Map<string, string>();
  for (const h of headers) {
    if (h.name && h.value) map.set(h.name.toLowerCase(), h.value);
  }
  return map;
}

function parseAddressList(value?: string): ParticipantInput[] {
  if (!value) return [];
  return value.split(',').map((part) => {
    const trimmed = part.trim();
    const match = trimmed.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
    if (!match) {
      return { email: trimmed.toLowerCase(), name: null, role: 'to' };
    }
    const name = match[1]?.trim() || null;
    const email = (match[2] || trimmed).trim().toLowerCase();
    return { email, name, role: 'to' };
  });
}

async function syncGoogleMailbox(
  mailboxId: string,
  mode: 'initial' | 'incremental',
  mailboxEmail: string,
  workspaceId: string,
) {
  const { gmail } = await getAuthorizedGmailClient(mailboxId);
  if (!gmail) throw new AppError('internal_error', 'Gmail client unavailable.', 500);

  // Initial sync walks the inbox in pages (up to INITIAL_SYNC_MAX messages,
  // 90 days back); incremental picks up the newest 50 each cycle.
  const INITIAL_SYNC_MAX = 300;
  const query = mode === 'initial' ? 'in:inbox newer_than:90d' : 'in:inbox newer_than:30d';
  const messageIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: mode === 'initial' ? 100 : 50,
      q: query,
      pageToken,
    });
    messageIds.push(...(list.data.messages ?? []).map((m) => m.id!).filter(Boolean));
    pageToken = list.data.nextPageToken ?? undefined;
  } while (mode === 'initial' && pageToken && messageIds.length < INITIAL_SYNC_MAX);
  for (const id of messageIds) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    const headers = headerMap(full.data.payload?.headers ?? []);
    const subject = headers.get('subject') ?? '(no subject)';
    const fromRaw = headers.get('from') ?? '';
    const fromParsed = parseAddressList(fromRaw)[0] ?? {
      email: 'unknown@example.com',
      name: null,
      role: 'from',
    };
    const to = parseAddressList(headers.get('to'));
    const cc = parseAddressList(headers.get('cc'));
    const direction: MessageDirection =
      fromParsed.email === mailboxEmail.toLowerCase() ? 'outbound' : 'inbound';

    let bodyHtml: string | null = null;
    let bodyText: string | null = null;
    const payload = full.data.payload;
    if (payload?.body?.data) {
      bodyText = decodeBody(payload.body.data);
    }
    for (const part of payload?.parts ?? []) {
      if (part.mimeType === 'text/html') bodyHtml = decodeBody(part.body?.data);
      if (part.mimeType === 'text/plain') bodyText = decodeBody(part.body?.data);
    }

    const stored = await upsertConversationMessage({
      workspaceId,
      mailboxId,
      mailboxEmail,
      gmailThreadId: full.data.threadId ?? id,
      gmailMessageId: full.data.id ?? id,
      direction,
      subject,
      snippet: full.data.snippet ?? '',
      bodyHtml,
      bodyText,
      fromEmail: fromParsed.email,
      fromName: fromParsed.name,
      to,
      cc,
      sentAt: new Date(Number(full.data.internalDate ?? Date.now())),
      rfcMessageId: headers.get('message-id') ?? null,
      inReplyTo: headers.get('in-reply-to') ?? null,
      referencesHeader: headers.get('references') ?? null,
      unread: (full.data.labelIds ?? []).includes('UNREAD'),
    });
    if (stored.created && direction === 'inbound' && !stored.isWarmup) {
      await enqueueClassification(stored.messageId);
    }
  }

  const profile = await gmail.users.getProfile({ userId: 'me' });
  await prisma.mailboxSyncState.upsert({
    where: { mailboxId },
    create: {
      mailboxId,
      historyId: profile.data.historyId?.toString() ?? null,
      lastSyncedAt: new Date(),
      initialSyncDone: true,
    },
    update: {
      historyId: profile.data.historyId?.toString() ?? null,
      lastSyncedAt: new Date(),
      initialSyncDone: true,
    },
  });

  return messageIds.length;
}

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  internetMessageId?: string;
}

function mapGraphRecipients(
  recipients: GraphRecipient[] | undefined,
  role: string,
): ParticipantInput[] {
  return (recipients ?? [])
    .map((r) => {
      const email = r.emailAddress?.address?.toLowerCase();
      if (!email) return null;
      return {
        email,
        name: r.emailAddress?.name ?? null,
        role,
      };
    })
    .filter(Boolean) as ParticipantInput[];
}

/**
 * First Graph request of a sync pass. Initial sync mirrors the Gmail path's
 * bounds ('in:inbox newer_than:90d'): inbox folder only, receivedDateTime
 * cutoff 90 days back, values URL-encoded. Incremental scans the newest
 * messages mailbox-wide, as before.
 */
export function buildGraphSyncPath(mode: 'initial' | 'incremental', now = new Date()): string {
  const top = mode === 'initial' ? 100 : 50;
  const select =
    '$select=id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,internetMessageId';
  const orderby = `$orderby=${encodeURIComponent('receivedDateTime desc')}`;
  if (mode !== 'initial') {
    return `/me/messages?$top=${top}&${orderby}&${select}`;
  }
  const cutoff = new Date(now.getTime() - 90 * 24 * 3600_000).toISOString();
  const filter = `$filter=${encodeURIComponent(`receivedDateTime ge ${cutoff}`)}`;
  return `/me/mailFolders/inbox/messages?$top=${top}&${filter}&${orderby}&${select}`;
}

async function syncMicrosoftMailbox(
  mailboxId: string,
  mode: 'initial' | 'incremental',
  mailboxEmail: string,
  workspaceId: string,
) {
  const { accessToken } = await getAuthorizedMicrosoftClient(mailboxId);
  if (!accessToken) throw new AppError('internal_error', 'Microsoft client unavailable.', 500);

  const INITIAL_SYNC_MAX = 300;
  const messages: GraphMessage[] = [];
  let next: string | null = buildGraphSyncPath(mode);
  while (next) {
    const data: { value?: GraphMessage[]; '@odata.nextLink'?: string } = await graphFetch(
      accessToken,
      next,
    );
    messages.push(...(data.value ?? []));
    const nextLink = data['@odata.nextLink'];
    next =
      mode === 'initial' && nextLink && messages.length < INITIAL_SYNC_MAX
        ? nextLink.replace('https://graph.microsoft.com/v1.0', '')
        : null;
  }

  for (const msg of messages) {
    const fromEmail = msg.from?.emailAddress?.address?.toLowerCase() ?? 'unknown@example.com';
    const fromName = msg.from?.emailAddress?.name ?? null;
    const direction: MessageDirection =
      fromEmail === mailboxEmail.toLowerCase() ? 'outbound' : 'inbound';
    const bodyHtml =
      msg.body?.contentType?.toLowerCase() === 'html' ? (msg.body.content ?? null) : null;
    const bodyText =
      msg.body?.contentType?.toLowerCase() === 'text'
        ? (msg.body.content ?? null)
        : (msg.bodyPreview ?? null);

    const stored = await upsertConversationMessage({
      workspaceId,
      mailboxId,
      mailboxEmail,
      gmailThreadId: msg.conversationId ?? msg.id,
      gmailMessageId: msg.id,
      direction,
      subject: msg.subject ?? '(no subject)',
      snippet: msg.bodyPreview ?? '',
      bodyHtml,
      bodyText,
      fromEmail,
      fromName,
      to: mapGraphRecipients(msg.toRecipients, 'to'),
      cc: mapGraphRecipients(msg.ccRecipients, 'cc'),
      sentAt: new Date(msg.sentDateTime ?? msg.receivedDateTime ?? Date.now()),
      rfcMessageId: msg.internetMessageId ?? null,
      unread: msg.isRead === false,
    });
    if (stored.created && direction === 'inbound' && !stored.isWarmup) {
      await enqueueClassification(stored.messageId);
    }
  }

  await prisma.mailboxSyncState.upsert({
    where: { mailboxId },
    create: {
      mailboxId,
      historyId: `ms-${Date.now()}`,
      lastSyncedAt: new Date(),
      initialSyncDone: true,
    },
    update: {
      historyId: `ms-${Date.now()}`,
      lastSyncedAt: new Date(),
      initialSyncDone: true,
    },
  });

  return messages.length;
}

export async function syncMailbox(mailboxId: string, mode: 'initial' | 'incremental') {
  const mailbox = await prisma.senderMailbox.findUnique({
    where: { id: mailboxId },
    include: { syncState: true },
  });
  if (!mailbox || mailbox.disconnectedAt) {
    throw new AppError('mailbox_revoked', 'Mailbox is disconnected.', 401);
  }

  await prisma.senderMailbox.update({
    where: { id: mailboxId },
    data: { health: 'syncing', lastError: null },
  });

  try {
    if (env.MAILBOX_MOCK) {
      // Mock mode skips provider calls entirely; it exists for automated tests,
      // which create their own fixtures. No sample data is ever seeded.
      await prisma.mailboxSyncState.upsert({
        where: { mailboxId },
        create: {
          mailboxId,
          historyId: `mock-${Date.now()}`,
          lastSyncedAt: new Date(),
          initialSyncDone: true,
        },
        update: {
          historyId: `mock-${Date.now()}`,
          lastSyncedAt: new Date(),
          initialSyncDone: true,
        },
      });
      await prisma.senderMailbox.update({
        where: { id: mailboxId },
        data: { health: 'healthy' },
      });
      return { synced: true, mode };
    }

    const count =
      mailbox.provider === 'microsoft'
        ? await syncMicrosoftMailbox(mailboxId, mode, mailbox.email, mailbox.workspaceId)
        : await syncGoogleMailbox(mailboxId, mode, mailbox.email, mailbox.workspaceId);

    await reconcilePendingSends(mailboxId);

    await prisma.senderMailbox.update({
      where: { id: mailboxId },
      data: { health: 'healthy', lastError: null },
    });

    return { synced: true, mode, count };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    await prisma.senderMailbox.update({
      where: { id: mailboxId },
      data: {
        health: message.toLowerCase().includes('invalid') ? 'auth_required' : 'error',
        lastError: message,
      },
    });
    throw error;
  }
}

