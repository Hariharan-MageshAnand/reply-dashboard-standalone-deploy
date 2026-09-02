import type { OutboundSend } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { getAuthorizedGmailClient } from './gmail-oauth.service.js';
import { getAuthorizedMicrosoftClient, graphFetch } from './microsoft-oauth.service.js';
import {
  LOCAL_OUTBOUND_PREFIX,
  upsertConversationMessage,
} from './message-store.service.js';

const SEND_TIMEOUT_MS = 30_000;
const RECONCILE_AFTER_MS = 2 * 60_000;
const RECONCILE_FAIL_AFTER_MS = 15 * 60_000;
const PENDING_SCHEDULE_STATUSES = ['scheduled', 'processing'] as const;

export type SendFailureKind = 'definitive' | 'ambiguous';

/**
 * Decides whether a failed provider call definitively did NOT send (safe to
 * retry) or is ambiguous (the request may have gone through — retrying could
 * double-send). Defaults to ambiguous: a wrongly-held send is recoverable via
 * reconciliation, a double-send to a prospect is not.
 */
export function classifySendError(error: unknown): { kind: SendFailureKind; message: string } {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Send failed';

  if (error instanceof AppError) {
    return { kind: 'definitive', message };
  }
  const err = error as {
    name?: string;
    code?: unknown;
    response?: { status?: unknown };
    cause?: { code?: unknown };
  };
  if (err?.name === 'SendTimeoutError' || err?.name === 'AbortError') {
    return { kind: 'ambiguous', message };
  }
  // The provider answered with an HTTP status — its answer is authoritative.
  if (typeof err?.response?.status === 'number') {
    return { kind: 'definitive', message };
  }
  const code = String(err?.code ?? err?.cause?.code ?? '');
  // These fail before any request reaches the provider, so nothing was sent.
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL'].includes(code)) {
    return { kind: 'definitive', message };
  }
  if (/^[45]\d\d$/.test(code)) {
    return { kind: 'definitive', message };
  }
  return { kind: 'ambiguous', message };
}

async function withSendTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Send timed out after ${SEND_TIMEOUT_MS / 1000}s with no provider response`);
      err.name = 'SendTimeoutError';
      reject(err);
    }, SEND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function encodeSubject(subject: string): string {
  const clean = sanitizeHeaderValue(subject);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

interface SendContext {
  conversation: {
    id: string;
    workspaceId: string;
    mailboxId: string;
    gmailThreadId: string;
    subject: string;
  };
  mailbox: { id: string; email: string; displayName: string | null; provider: string };
  replyTo: string;
  subject: string;
  latestInbound: {
    gmailMessageId: string;
    rfcMessageId: string | null;
    referencesHeader: string | null;
  } | null;
  bodyHtml: string;
  bodyText: string;
}

async function sendViaGmail(ctx: SendContext, attemptId: string) {
  const { gmail } = await getAuthorizedGmailClient(ctx.mailbox.id);
  if (!gmail) throw new AppError('internal_error', 'Gmail client unavailable.', 500);

  const boundary = `b-${attemptId}`;
  const rfcInReplyTo = ctx.latestInbound?.rfcMessageId ?? null;
  const references = rfcInReplyTo
    ? [ctx.latestInbound?.referencesHeader, rfcInReplyTo].filter(Boolean).join(' ')
    : null;

  const rawLines = [
    `To: ${sanitizeHeaderValue(ctx.replyTo)}`,
    `From: ${sanitizeHeaderValue(ctx.mailbox.email)}`,
    `Subject: ${encodeSubject(ctx.subject)}`,
    ...(rfcInReplyTo ? [`In-Reply-To: ${rfcInReplyTo}`, `References: ${references}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    ctx.bodyText,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    ctx.bodyHtml,
    `--${boundary}--`,
  ];
  const raw = Buffer.from(rawLines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sent = await withSendTimeout(
    gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: ctx.conversation.gmailThreadId },
    }),
  );
  return {
    providerMessageId: sent.data.id ?? null,
    providerThreadId: sent.data.threadId ?? ctx.conversation.gmailThreadId,
  };
}

async function sendViaMicrosoft(ctx: SendContext) {
  const { accessToken } = await getAuthorizedMicrosoftClient(ctx.mailbox.id);
  if (!accessToken) throw new AppError('internal_error', 'Microsoft client unavailable.', 500);

  const replyTargetId =
    ctx.latestInbound && !ctx.latestInbound.gmailMessageId.startsWith(LOCAL_OUTBOUND_PREFIX)
      ? ctx.latestInbound.gmailMessageId
      : null;

  if (replyTargetId) {
    try {
      await withSendTimeout(
        graphFetch(accessToken, `/me/messages/${replyTargetId}/reply`, {
          method: 'POST',
          body: JSON.stringify({ comment: ctx.bodyText }),
        }),
      );
      return { providerMessageId: null, providerThreadId: ctx.conversation.gmailThreadId };
    } catch (error) {
      // Only fall through to a fresh sendMail when the reply call definitively
      // failed. On an ambiguous failure the reply may have gone out — sending
      // again here is exactly the double-send the state machine exists to stop.
      if (classifySendError(error).kind !== 'definitive') throw error;
    }
  }

  await withSendTimeout(
    graphFetch(accessToken, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: ctx.subject,
          body: { contentType: 'HTML', content: ctx.bodyHtml },
          toRecipients: [{ emailAddress: { address: ctx.replyTo } }],
        },
        saveToSentItems: true,
      }),
    }),
  );
  return { providerMessageId: null, providerThreadId: ctx.conversation.gmailThreadId };
}

/**
 * Releases the send lock. When `owned` is passed, releases only if the lock
 * still carries that exact acquisition timestamp — a sender must never clear a
 * lock another sender has since acquired.
 */
async function releaseSendLock(conversationId: string, owned?: Date) {
  await prisma.conversation.updateMany({
    where: { id: conversationId, ...(owned ? { sendLockedAt: owned } : {}) },
    data: { sendLockedAt: null },
  });
}

// Test-only seams for the concurrency test: pause inside the acquire
// transaction (after the lock, before the attempt commits) and after the
// attempt is persisted (while the send is in flight).
export const sendTestHooks: {
  afterLockInTx?: () => Promise<void>;
  afterAttemptPersisted?: () => Promise<void>;
  /** Pause between the standalone approval precheck and the transactional
   * claim, so an approval request can interleave (TOCTOU regression tests). */
  afterApprovalPrecheck?: () => Promise<void>;
  /** Pause inside the reconciliation transaction, between terminalizing the
   * attempt and releasing the lock (interleaving regression tests). */
  betweenReconcileTerminalizeAndRelease?: () => Promise<void>;
} = {};

function approvalPendingError(message: string) {
  return new AppError(
    'approval_pending',
    message,
    409,
    undefined,
    'Wait for the Lead to respond, or override after 24 hours.',
  );
}

// Test-only seams for scheduled-send races: pause between reading the due rows
// and claiming them (inbound auto-cancel), and after a successful claim
// before the provider send (a second schedule must still be rejected).
export const scheduledSendTestHooks: {
  afterDueSelection?: () => Promise<void>;
  afterClaim?: () => Promise<void>;
} = {};

async function recordSentMessage(
  ctx: SendContext,
  attemptId: string,
  providerMessageId: string | null,
  providerThreadId: string,
) {
  await upsertConversationMessage({
    workspaceId: ctx.conversation.workspaceId,
    mailboxId: ctx.mailbox.id,
    mailboxEmail: ctx.mailbox.email,
    gmailThreadId: providerThreadId,
    gmailMessageId: providerMessageId ?? `${LOCAL_OUTBOUND_PREFIX}${attemptId}`,
    direction: 'outbound',
    subject: ctx.subject,
    snippet: ctx.bodyText.slice(0, 140),
    bodyHtml: ctx.bodyHtml,
    bodyText: ctx.bodyText,
    fromEmail: ctx.mailbox.email,
    fromName: ctx.mailbox.displayName,
    to: [{ email: ctx.replyTo, name: null, role: 'to' }],
    cc: [],
    sentAt: new Date(),
    inReplyTo: ctx.latestInbound?.rfcMessageId ?? null,
    referencesHeader: ctx.latestInbound?.referencesHeader ?? null,
    unread: false,
  });
  await prisma.conversation.update({
    where: { id: ctx.conversation.id },
    data: {
      unread: false,
      replyStatus: 'replied',
      lastMessageAt: new Date(),
      // Responding clears the SLA breach tag (PRD 5.8).
      slaBreachedAt: null,
    },
  });
  await prisma.replyDraft.deleteMany({ where: { conversationId: ctx.conversation.id } });
}

async function buildSendContext(
  workspaceId: string,
  conversationId: string,
  bodyHtml: string,
  bodyText: string,
): Promise<SendContext> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: {
      mailbox: true,
      participants: true,
      messages: { orderBy: { sentAt: 'desc' } },
    },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);
  if (!conversation.mailbox.canSend || conversation.mailbox.disconnectedAt) {
    throw new AppError(
      'reply_failed',
      'This mailbox cannot send replies right now.',
      400,
      undefined,
      'Reconnect the mailbox and ensure send permission is granted.',
    );
  }

  const latestInbound = conversation.messages.find((m) => m.direction === 'inbound') ?? null;
  // Recipient is always the counterparty on the existing thread — never editable.
  const replyTo =
    latestInbound?.fromEmail ??
    conversation.participants.find(
      (p) => (p.role === 'from' || p.role === 'to') && p.email !== conversation.mailbox.email,
    )?.email;
  if (!replyTo) {
    throw new AppError('reply_failed', 'Could not determine reply recipient.', 400);
  }

  const subject = conversation.subject.toLowerCase().startsWith('re:')
    ? conversation.subject
    : `Re: ${conversation.subject}`;

  return {
    conversation: {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      mailboxId: conversation.mailboxId,
      gmailThreadId: conversation.gmailThreadId,
      subject: conversation.subject,
    },
    mailbox: {
      id: conversation.mailbox.id,
      email: conversation.mailbox.email,
      displayName: conversation.mailbox.displayName,
      provider: conversation.mailbox.provider,
    },
    replyTo,
    subject,
    latestInbound: latestInbound
      ? {
          gmailMessageId: latestInbound.gmailMessageId,
          rfcMessageId: latestInbound.rfcMessageId,
          referencesHeader: latestInbound.referencesHeader,
        }
      : null,
    bodyHtml,
    bodyText,
  };
}

export type SendOutcome = { outcome: 'sent' | 'pending'; replayed: boolean };

export async function sendConversationReply(input: {
  workspaceId: string;
  conversationId: string;
  authorId: string;
  bodyHtml: string;
  bodyText: string;
  idempotencyKey: string;
  /** Set when the due-send processor is delivering a claimed scheduled row so
   * a concurrent manual send can cancel that claim instead of double-sending. */
  scheduledSendId?: string;
}): Promise<SendOutcome> {
  const replayed = await prisma.outboundSend.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (replayed) {
    if (replayed.status === 'failed') {
      throw new AppError(
        'reply_failed',
        replayed.errorMessage ?? 'The previous send attempt failed.',
        502,
        undefined,
        'Your draft is preserved — send again to retry.',
      );
    }
    return { outcome: replayed.status === 'sent' ? 'sent' : 'pending', replayed: true };
  }

  // PRD 5.5: a pending approval request is a hard block on Send — not a
  // dismissible warning. This early check gives a fast, clear rejection; the
  // authoritative recheck lives inside the lock transaction below, because an
  // approval request can land between here and the claim.
  const pendingApproval = await prisma.approvalRequest.findFirst({
    where: { conversationId: input.conversationId, status: 'pending' },
  });
  if (pendingApproval) {
    throw approvalPendingError('Send is blocked while Sourcing Lead sign-off is pending.');
  }
  if (sendTestHooks.afterApprovalPrecheck) await sendTestHooks.afterApprovalPrecheck();

  const ctx = await buildSendContext(
    input.workspaceId,
    input.conversationId,
    input.bodyHtml,
    input.bodyText,
  );

  // The lock and the OutboundSend row commit in ONE transaction, so no other
  // request can ever observe "lock held, attempt row missing" for a live
  // sender — the race a lock-then-create sequence would allow. Concurrent
  // acquires serialize on the conversation row lock inside Postgres.
  const lockStamp = new Date();
  const acquireLockAndCreateAttempt = async (): Promise<
    { attempt: OutboundSend; replayed: boolean } | null
  > => {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const locked = await tx.conversation.updateMany({
          where: { id: ctx.conversation.id, sendLockedAt: null },
          data: { sendLockedAt: lockStamp },
        });
        if (!locked.count) return null;
        // Authoritative approval gate: the CAS above row-locks the
        // conversation, and requestApproval serializes on the same row (FOR
        // UPDATE), so this recheck cannot miss a request committed after the
        // standalone precheck. Throwing rolls back the lock and the attempt.
        const approvalBlocked = await tx.approvalRequest.findFirst({
          where: { conversationId: ctx.conversation.id, status: 'pending' },
          select: { id: true },
        });
        if (approvalBlocked) {
          throw approvalPendingError('Send is blocked while Sourcing Lead sign-off is pending.');
        }
        if (input.scheduledSendId) {
          const stillClaimed = await tx.scheduledSend.findFirst({
            where: {
              id: input.scheduledSendId,
              conversationId: ctx.conversation.id,
              status: 'processing',
            },
            select: { id: true },
          });
          if (!stillClaimed) throw conflictError();
        } else {
          // Immediate send and a queued Send Later are mutually exclusive: the
          // operator chose to send now, so the queued payload must not also fire.
          await tx.scheduledSend.updateMany({
            where: {
              conversationId: ctx.conversation.id,
              status: { in: [...PENDING_SCHEDULE_STATUSES] },
            },
            data: { status: 'cancelled', cancelReason: 'superseded_by_manual_send' },
          });
        }
        if (sendTestHooks.afterLockInTx) await sendTestHooks.afterLockInTx();
        return tx.outboundSend.create({
          data: {
            conversationId: ctx.conversation.id,
            authorId: input.authorId,
            idempotencyKey: input.idempotencyKey,
            status: 'sending',
            bodyHtml: input.bodyHtml,
            bodyText: input.bodyText,
          },
        });
      });
      return created ? { attempt: created, replayed: false } : null;
    } catch (error) {
      // Duplicate idempotencyKey: the same request landed via another path.
      // The transaction already rolled the lock back.
      const raced = await prisma.outboundSend.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (raced) return { attempt: raced, replayed: true };
      throw error;
    }
  };
  const conflictError = () =>
    new AppError(
      'conflict',
      'A send is already in progress for this conversation.',
      409,
      undefined,
      'Wait for the current send to resolve before sending again.',
    );

  let acquired = await acquireLockAndCreateAttempt();
  if (!acquired) {
    // Lock is held by someone else. Read the lock value BEFORE checking for a
    // live attempt: because lock + attempt commit together, a lock value
    // observed while no 'sending' attempt exists can only belong to a stale
    // holder (crash between a terminal attempt update and its lock release).
    const observed = await prisma.conversation.findUnique({
      where: { id: ctx.conversation.id },
      select: { sendLockedAt: true },
    });
    const pending = await prisma.outboundSend.findFirst({
      where: { conversationId: ctx.conversation.id, status: 'sending' },
    });
    if (pending) throw conflictError();
    if (observed?.sendLockedAt) {
      // Release ONLY the exact stale lock we observed — never one a concurrent
      // sender acquired since.
      await releaseSendLock(ctx.conversation.id, observed.sendLockedAt);
    }
    acquired = await acquireLockAndCreateAttempt();
    if (!acquired) throw conflictError();
  }

  if (acquired.replayed) {
    const raced = acquired.attempt;
    if (raced.status === 'failed') {
      throw new AppError(
        'reply_failed',
        raced.errorMessage ?? 'The previous send attempt failed.',
        502,
        undefined,
        'Your draft is preserved — send again to retry.',
      );
    }
    return { outcome: raced.status === 'sent' ? 'sent' : 'pending', replayed: true };
  }
  const attempt = acquired.attempt;
  if (sendTestHooks.afterAttemptPersisted) await sendTestHooks.afterAttemptPersisted();

  try {
    const result = env.MAILBOX_MOCK
      ? { providerMessageId: `mock-out-${attempt.id}`, providerThreadId: ctx.conversation.gmailThreadId }
      : ctx.mailbox.provider === 'microsoft'
        ? await sendViaMicrosoft(ctx)
        : await sendViaGmail(ctx, attempt.id);

    await prisma.outboundSend.update({
      where: { id: attempt.id },
      data: {
        status: 'sent',
        sentAt: new Date(),
        providerMessageId: result.providerMessageId,
      },
    });
    await recordSentMessage(ctx, attempt.id, result.providerMessageId, result.providerThreadId);
    await releaseSendLock(ctx.conversation.id, lockStamp);
    return { outcome: 'sent', replayed: false };
  } catch (error) {
    const failure = classifySendError(error);
    if (failure.kind === 'definitive') {
      await prisma.outboundSend.update({
        where: { id: attempt.id },
        data: { status: 'failed', errorMessage: failure.message },
      });
      await releaseSendLock(ctx.conversation.id, lockStamp);
      throw new AppError(
        'reply_failed',
        `Send failed: ${failure.message}`,
        502,
        undefined,
        'Your draft is preserved — send again to retry.',
      );
    }
    // Ambiguous: the provider may have accepted the send. Keep the attempt in
    // 'sending' and the conversation locked; reconciliation resolves it by
    // checking the thread, never by guessing.
    console.error(
      `send attempt ${attempt.id} ambiguous (${failure.message}) — holding for reconciliation`,
    );
    return { outcome: 'pending', replayed: false };
  }
}

/**
 * Terminalizes a reconciled attempt and releases its lock in ONE transaction.
 * Sequential updates left a window where the attempt was terminal but the
 * lock still held: a new sender's stale-lock self-heal could acquire in that
 * window, and the delayed unguarded release would then clear the NEW lock.
 * Atomicity removes the window, and the status guard means the release only
 * runs when this call was the one to resolve a live attempt — while an
 * attempt is 'sending', its lock cannot belong to anyone else.
 */
async function terminalizeAndRelease(
  attempt: { id: string; conversationId: string },
  data: { status: 'sent' | 'failed'; sentAt?: Date; providerMessageId?: string | null; errorMessage?: string },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.outboundSend.updateMany({
      where: { id: attempt.id, status: 'sending' },
      data,
    });
    if (!updated.count) return false;
    if (sendTestHooks.betweenReconcileTerminalizeAndRelease) {
      await sendTestHooks.betweenReconcileTerminalizeAndRelease();
    }
    await tx.conversation.updateMany({
      where: { id: attempt.conversationId },
      data: { sendLockedAt: null },
    });
    return true;
  });
}

export async function markReconciledSent(
  attempt: { id: string; conversationId: string; bodyHtml: string; bodyText: string },
  ctx: SendContext,
  providerMessageId: string | null,
  sentAt: Date,
) {
  const resolved = await terminalizeAndRelease(attempt, {
    status: 'sent',
    sentAt,
    providerMessageId,
  });
  if (!resolved) return;
  // After the terminal commit: if this write fails, the real message exists in
  // the provider thread and the next sync imports it.
  await recordSentMessage(
    { ...ctx, bodyHtml: attempt.bodyHtml, bodyText: attempt.bodyText },
    attempt.id,
    providerMessageId,
    ctx.conversation.gmailThreadId,
  );
}

export async function markReconciledFailed(attempt: { id: string; conversationId: string }) {
  await terminalizeAndRelease(attempt, {
    status: 'failed',
    errorMessage:
      'Send could not be confirmed and no sent message was found in the thread. Safe to retry.',
  });
}

export async function scheduleReply(input: {
  workspaceId: string;
  conversationId: string;
  authorId: string;
  bodyHtml: string;
  bodyText: string;
  scheduledFor: Date;
}) {
  if (input.scheduledFor.getTime() <= Date.now()) {
    throw new AppError('validation_error', 'Scheduled send time must be in the future.', 400, {
      scheduledFor: 'Pick a future date and time.',
    });
  }
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    include: { mailbox: true },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);
  if (!conversation.mailbox.canSend || conversation.mailbox.disconnectedAt) {
    throw new AppError('reply_failed', 'This mailbox cannot send replies right now.', 400);
  }
  const pendingApproval = await prisma.approvalRequest.findFirst({
    where: { conversationId: conversation.id, status: 'pending' },
  });
  if (pendingApproval) {
    throw approvalPendingError('Scheduling is blocked while Sourcing Lead sign-off is pending.');
  }
  if (sendTestHooks.afterApprovalPrecheck) await sendTestHooks.afterApprovalPrecheck();

  // The standalone check above is a fast path; the ones inside the
  // transaction are authoritative. FOR UPDATE on the conversation row is the
  // serialization point shared with requestApproval and concurrent schedule
  // requests, so an approval request or a rival scheduled row committed after
  // the precheck is always seen here — and vice versa.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversation.id} FOR UPDATE`;
    const approvalBlocked = await tx.approvalRequest.findFirst({
      where: { conversationId: conversation.id, status: 'pending' },
      select: { id: true },
    });
    if (approvalBlocked) {
      throw approvalPendingError('Scheduling is blocked while Sourcing Lead sign-off is pending.');
    }
    const duplicate = await tx.scheduledSend.findFirst({
      // `processing` is still a live queued send — omitting it would let a
      // second schedule land while the first is already being delivered.
      where: {
        conversationId: conversation.id,
        status: { in: [...PENDING_SCHEDULE_STATUSES] },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppError(
        'conflict',
        'A scheduled send already exists for this conversation.',
        409,
        undefined,
        'Cancel the existing scheduled send first.',
      );
    }
    const scheduled = await tx.scheduledSend.create({
      data: {
        conversationId: conversation.id,
        authorId: input.authorId,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        scheduledFor: input.scheduledFor,
      },
    });
    // The scheduled row now holds the content; an empty composer makes the
    // "queued" state unambiguous in the UI.
    await tx.replyDraft.deleteMany({ where: { conversationId: conversation.id } });
    return scheduled;
  });
}

export async function cancelScheduledReply(workspaceId: string, conversationId: string) {
  const pending = await prisma.scheduledSend.findFirst({
    where: {
      conversationId,
      status: { in: [...PENDING_SCHEDULE_STATUSES] },
      conversation: { workspaceId },
    },
  });
  if (!pending) {
    throw new AppError('not_found', 'No pending scheduled send for this conversation.', 404);
  }
  // A claimed row is already being delivered — cancelling it would lie about a
  // message that may already be in the provider thread.
  if (pending.status === 'processing') {
    throw new AppError(
      'conflict',
      'This scheduled send is already being delivered and can no longer be cancelled.',
      409,
    );
  }
  // Status-guarded: if the processor claimed or sent the row since our read,
  // cancelling would misreport a message that is (being) delivered.
  const cancelled = await prisma.scheduledSend.updateMany({
    where: { id: pending.id, status: 'scheduled' },
    data: { status: 'cancelled', cancelReason: 'cancelled_by_operator' },
  });
  if (cancelled.count === 0) {
    throw new AppError(
      'conflict',
      'This scheduled send is already being delivered and can no longer be cancelled.',
      409,
    );
  }
  // Restore the content as a draft so the operator's writing is never lost.
  await prisma.replyDraft.upsert({
    where: { conversationId },
    create: {
      conversationId,
      authorId: pending.authorId,
      bodyHtml: pending.bodyHtml,
      bodyText: pending.bodyText,
    },
    update: { bodyHtml: pending.bodyHtml, bodyText: pending.bodyText },
  });
}

/**
 * Fires due scheduled sends through the same state machine as manual sends —
 * same double-send protection, same ambiguity handling. A conflict (e.g. a
 * manual send in flight) leaves the row scheduled for the next tick; a
 * definitive failure marks it failed and flags the conversation unread so the
 * operator sees it (PRD: no silent failures).
 */
const STALE_PROCESSING_MS = 10 * 60_000;

export async function processDueScheduledSends(now = new Date()) {
  // Self-heal rows stranded in 'processing' by a crash mid-send: return them
  // to 'scheduled' after a grace period. The per-row idempotency key makes the
  // replay safe — an attempt that actually landed resolves as a conflict.
  await prisma.scheduledSend.updateMany({
    where: { status: 'processing', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } },
    data: { status: 'scheduled' },
  });

  const due = await prisma.scheduledSend.findMany({
    where: { status: 'scheduled', scheduledFor: { lte: now } },
    include: { conversation: true },
  });
  if (scheduledSendTestHooks.afterDueSelection) await scheduledSendTestHooks.afterDueSelection();
  let fired = 0;
  for (const row of due) {
    // Claim the row before sending: only a compare-and-swap away from
    // 'scheduled' may proceed. If an inbound reply auto-cancelled (or an
    // operator cancelled) the row after we read it, the claim loses and the
    // stale-context message must not go out.
    const claim = await prisma.scheduledSend.updateMany({
      where: { id: row.id, status: 'scheduled' },
      data: { status: 'processing' },
    });
    if (claim.count === 0) continue;
    if (scheduledSendTestHooks.afterClaim) await scheduledSendTestHooks.afterClaim();
    try {
      const result = await sendConversationReply({
        workspaceId: row.conversation.workspaceId,
        conversationId: row.conversationId,
        authorId: row.authorId,
        bodyHtml: row.bodyHtml,
        bodyText: row.bodyText,
        idempotencyKey: `sched-${row.id}`,
        scheduledSendId: row.id,
      });
      if (result.outcome === 'sent') {
        await prisma.scheduledSend.updateMany({
          where: { id: row.id, status: 'processing' },
          data: { status: 'sent' },
        });
        fired += 1;
      } else {
        // 'pending' (ambiguous provider response): release the claim so the
        // idempotency key replays it next tick, and reconciliation resolves
        // the attempt itself.
        await prisma.scheduledSend.updateMany({
          where: { id: row.id, status: 'processing' },
          data: { status: 'scheduled' },
        });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'conflict') {
        // A manual send is in flight — release the claim and retry next tick.
        await prisma.scheduledSend.updateMany({
          where: { id: row.id, status: 'processing' },
          data: { status: 'scheduled' },
        });
        continue;
      }
      const message = error instanceof Error ? error.message : 'Scheduled send failed';
      await prisma.scheduledSend.updateMany({
        where: { id: row.id, status: 'processing' },
        data: { status: 'failed', errorMessage: message },
      });
      await prisma.conversation.update({
        where: { id: row.conversationId },
        data: { unread: true, replyStatus: 'needs_attention' },
      });
      console.error(`scheduled send ${row.id} failed: ${message}`);
    }
  }
  return fired;
}

/**
 * Resolves attempts stuck in 'sending' after an ambiguous provider response by
 * positively checking the thread: a matching outbound message from the mailbox
 * proves the send landed; a clean thread after the failure window proves it
 * did not. Called after each mailbox sync cycle.
 */
export async function reconcilePendingSends(mailboxId: string) {
  if (env.MAILBOX_MOCK) return;
  const pending = await prisma.outboundSend.findMany({
    where: {
      status: 'sending',
      createdAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
      conversation: { mailboxId },
    },
    include: { conversation: { include: { mailbox: true } } },
  });

  for (const attempt of pending) {
    const conversation = attempt.conversation;
    const mailbox = conversation.mailbox;
    const windowStart = attempt.createdAt.getTime() - 60_000;
    try {
      const ctx = await buildSendContext(
        conversation.workspaceId,
        conversation.id,
        attempt.bodyHtml,
        attempt.bodyText,
      );

      let confirmed: { providerMessageId: string | null; sentAt: Date } | null = null;
      if (mailbox.provider === 'google') {
        const { gmail } = await getAuthorizedGmailClient(mailbox.id);
        if (!gmail) continue;
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: conversation.gmailThreadId,
          format: 'metadata',
          metadataHeaders: ['From'],
        });
        for (const msg of thread.data.messages ?? []) {
          const from = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === 'from');
          const internalDate = Number(msg.internalDate ?? 0);
          if (
            from?.value?.toLowerCase().includes(mailbox.email.toLowerCase()) &&
            internalDate >= windowStart
          ) {
            confirmed = { providerMessageId: msg.id ?? null, sentAt: new Date(internalDate) };
            break;
          }
        }
      } else {
        const { accessToken } = await getAuthorizedMicrosoftClient(mailbox.id);
        if (!accessToken) continue;
        const escapedConversationId = conversation.gmailThreadId.replace(/'/g, "''");
        const data = await graphFetch<{
          value: Array<{ id: string; sentDateTime?: string }>;
        }>(
          accessToken,
          `/me/mailFolders('sentitems')/messages?$filter=conversationId eq '${escapedConversationId}'&$top=10&$select=id,sentDateTime`,
        );
        for (const msg of data.value ?? []) {
          const sentTime = new Date(msg.sentDateTime ?? 0).getTime();
          if (sentTime >= windowStart) {
            confirmed = { providerMessageId: msg.id, sentAt: new Date(sentTime) };
            break;
          }
        }
      }

      if (confirmed) {
        await markReconciledSent(attempt, ctx, confirmed.providerMessageId, confirmed.sentAt);
      } else if (Date.now() - attempt.createdAt.getTime() > RECONCILE_FAIL_AFTER_MS) {
        await markReconciledFailed(attempt);
      }
    } catch (error) {
      // Leave the attempt pending; the next sync cycle retries reconciliation.
      console.error(`reconcile of send attempt ${attempt.id} failed`, error);
    }
  }
}
