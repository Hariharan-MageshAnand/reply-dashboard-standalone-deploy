import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { sendTransactionalEmail } from './email.service.js';

const REMINDER_AFTER_MS = 4 * 3600_000;
const OVERRIDE_AFTER_MS = 24 * 3600_000;

function token() {
  return randomBytes(24).toString('base64url');
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function approvalEmailHtml(input: {
  draft: string;
  originalReply: string | null;
  subject: string;
  approveUrl: string;
  changesUrl: string;
  reminder?: boolean;
}) {
  return `
  <div style="font-family: sans-serif; max-width: 640px">
    <p>${input.reminder ? '<strong>Reminder:</strong> a' : 'A'} response is waiting for your sign-off${input.reminder ? ' (requested over 4 hours ago)' : ''}.</p>
    <p style="color:#666">Thread: <strong>${escapeHtml(input.subject)}</strong></p>
    ${
      input.originalReply
        ? `<p style="margin-bottom:4px;color:#666">Their reply:</p>
           <blockquote style="border-left:3px solid #ccc;margin:0 0 16px;padding:8px 12px;white-space:pre-wrap">${escapeHtml(input.originalReply)}</blockquote>`
        : ''
    }
    <p style="margin-bottom:4px;color:#666">Draft response (current version):</p>
    <blockquote style="border-left:3px solid #6b9137;margin:0 0 20px;padding:8px 12px;white-space:pre-wrap">${escapeHtml(input.draft)}</blockquote>
    <p>
      <a href="${input.approveUrl}" style="background:#163a24;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-right:12px">Approve</a>
      <a href="${input.changesUrl}" style="border:1px solid #163a24;color:#163a24;padding:10px 18px;border-radius:8px;text-decoration:none">Request changes</a>
    </p>
    <p style="color:#999;font-size:12px">One-click links, single use. Sending stays blocked until you act (or the operator overrides after 24h).</p>
  </div>`;
}

export async function getPendingApproval(conversationId: string) {
  return prisma.approvalRequest.findFirst({
    where: { conversationId, status: 'pending' },
  });
}

/**
 * Operator requests sign-off. Send is hard-blocked for the conversation from
 * this moment until Approved / Changes Requested / Overridden (PRD 5.5 —
 * "never theater").
 */
export async function requestApproval(input: {
  workspaceId: string;
  conversationId: string;
  requestedById: string;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    include: {
      workspace: true,
      draft: true,
      messages: { where: { direction: 'inbound' }, orderBy: { sentAt: 'desc' }, take: 1 },
    },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);
  if (!conversation.draft?.bodyText?.trim()) {
    throw new AppError('validation_error', 'Write or generate a draft before requesting sign-off.', 400);
  }
  const leadEmail = conversation.workspace.sourcingLeadEmail;
  if (!leadEmail) {
    throw new AppError(
      'validation_error',
      'No Sourcing Lead email configured.',
      400,
      undefined,
      'Set the Sourcing Lead email in Settings first.',
    );
  }
  // Serialized per conversation: FOR UPDATE on the conversation row is the
  // same lock the send/schedule transactions take, so two concurrent requests
  // (or a request racing a send claim) cannot both pass the pending check —
  // exactly one creates a row, the loser gets the 409.
  const draftSnapshot = conversation.draft.bodyText;
  const request = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversation.id} FOR UPDATE`;
    const pending = await tx.approvalRequest.findFirst({
      where: { conversationId: conversation.id, status: 'pending' },
      select: { id: true },
    });
    if (pending) {
      throw new AppError('conflict', 'An approval request is already pending.', 409);
    }
    // The Lead always reviews the CURRENT draft — never a stale earlier version.
    return tx.approvalRequest.create({
      data: {
        conversationId: conversation.id,
        draftSnapshot,
        requestedById: input.requestedById,
        sentToEmail: leadEmail,
        approveToken: token(),
        changesToken: token(),
      },
    });
  });

  const result = await sendTransactionalEmail({
    to: leadEmail,
    subject: `Sign-off requested: ${conversation.subject}`,
    html: approvalEmailHtml({
      draft: conversation.draft.bodyText,
      originalReply: conversation.messages[0]?.bodyText ?? null,
      subject: conversation.subject,
      approveUrl: `${env.API_PUBLIC_URL}/api/approvals/${request.approveToken}/approve`,
      changesUrl: `${env.API_PUBLIC_URL}/api/approvals/${request.changesToken}/changes`,
    }),
  });

  if (!result.delivered && env.EMAIL_READY) {
    // PRD 5.5: never leave Send silently blocked with no explanation. A
    // configured provider that fails rolls the request back with a retryable
    // error.
    await prisma.approvalRequest.delete({ where: { id: request.id } });
    throw new AppError(
      'provider_error',
      `Approval request could not be sent: ${result.error}`,
      502,
      undefined,
      'Retry — if it keeps failing, check the email provider status.',
    );
  }
  if (!result.delivered) {
    // Dev mode (no provider yet): keep the flow usable end-to-end by printing
    // the one-click links to the server log.
    console.log(
      `[approval:dev] approve:  ${env.API_PUBLIC_URL}/api/approvals/${request.approveToken}/approve\n` +
        `[approval:dev] changes: ${env.API_PUBLIC_URL}/api/approvals/${request.changesToken}/changes`,
    );
  }

  return request;
}

/** Single-use approve link. Returns HTML for the Lead's browser. */
export async function resolveApprove(approveToken: string): Promise<string> {
  const request = await prisma.approvalRequest.findUnique({ where: { approveToken } });
  if (!request) return page('This link is invalid.');
  // Atomic single-use transition: only the first resolver wins; a concurrent
  // approve/changes click loses the conditional update and gets the
  // already-handled page.
  const won = await prisma.approvalRequest.updateMany({
    where: { id: request.id, status: 'pending' },
    data: { status: 'approved', resolvedAt: new Date() },
  });
  if (!won.count) {
    return page('This request has already been handled.');
  }
  // In-app notification: surface the resolution on the conversation.
  await prisma.conversation.update({
    where: { id: request.conversationId },
    data: { unread: true },
  });
  return page('Approved ✓ — the operator can now send. You can close this tab.');
}

/** Changes form (GET). */
export async function changesForm(changesToken: string): Promise<string> {
  const request = await prisma.approvalRequest.findUnique({ where: { changesToken } });
  if (!request) return page('This link is invalid.');
  if (request.status !== 'pending') {
    return page('This request has already been handled.');
  }
  return page(`
    <p style="margin-top:0">What should change? (optional — submitting without a comment still flags the draft)</p>
    <form method="POST" style="display:grid;gap:12px">
      <textarea name="comment" rows="5" style="font:inherit;padding:10px;border-radius:8px;border:1px solid #ccc" placeholder="e.g. Don't mention the acquisition — keep it to one line and propose Thursday."></textarea>
      <button type="submit" style="background:#163a24;color:#fff;border:0;padding:10px 18px;border-radius:8px;font:inherit;cursor:pointer;justify-self:start">Request changes</button>
    </form>`);
}

/** Changes submission (POST). Comments are append-only (PRD 7.3). */
export async function submitChanges(changesToken: string, comment: string): Promise<string> {
  const request = await prisma.approvalRequest.findUnique({ where: { changesToken } });
  if (!request) return page('This link is invalid.');
  // Atomic single-use transition (see resolveApprove) — the comment is only
  // written after winning it, so a late changes click can never override an
  // approval or double-append.
  const won = await prisma.approvalRequest.updateMany({
    where: { id: request.id, status: 'pending' },
    data: { status: 'changes_requested', resolvedAt: new Date() },
  });
  if (!won.count) {
    return page('This request has already been handled.');
  }
  await prisma.approvalComment.create({
    data: {
      approvalRequestId: request.id,
      commentText: comment.trim() || null,
      // Always the snapshot that was EMAILED to the Lead — the operator may
      // have edited the working draft since, and the audit trail must show
      // what the Lead was actually commenting on.
      draftSnapshotAtComment: request.draftSnapshot,
    },
  });
  await prisma.conversation.update({
    where: { id: request.conversationId },
    data: { unread: true, replyStatus: 'needs_attention' },
  });
  return page('Sent to the operator ✓ — they will revise and may re-request sign-off. You can close this tab.');
}

/**
 * Operator override — a deliberate manual choice, only offered after 24h with
 * no Lead response (PRD 5.5).
 */
// Test-only seam: pause override between reading the pending request and the
// guarded transition, so a Lead decision can interleave (race regression tests).
export const approvalTestHooks: {
  afterOverrideRead?: () => Promise<void>;
  afterReminderSelection?: () => Promise<void>;
} = {};

export async function overrideApproval(input: {
  workspaceId: string;
  conversationId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const request = await prisma.approvalRequest.findFirst({
    where: {
      conversationId: input.conversationId,
      status: 'pending',
      conversation: { workspaceId: input.workspaceId },
    },
  });
  if (!request) throw new AppError('not_found', 'No pending approval to override.', 404);
  if (now.getTime() - request.requestedAt.getTime() < OVERRIDE_AFTER_MS) {
    throw new AppError(
      'validation_error',
      'Override unlocks 24 hours after the request if the Lead has not responded.',
      400,
    );
  }
  if (approvalTestHooks.afterOverrideRead) await approvalTestHooks.afterOverrideRead();
  // Authoritative conditional transition: only a request that is STILL pending
  // (and still past the age threshold) can be overridden. If the Lead's
  // approve/changes transition won the race after our read, their decision
  // stands — overwriting it would corrupt the approval audit trail.
  const overridden = await prisma.approvalRequest.updateMany({
    where: {
      id: request.id,
      status: 'pending',
      requestedAt: { lte: new Date(now.getTime() - OVERRIDE_AFTER_MS) },
    },
    data: { status: 'overridden', resolvedAt: now },
  });
  if (!overridden.count) {
    throw new AppError(
      'conflict',
      'The Lead already responded — their decision stands and nothing was overridden.',
      409,
    );
  }
}

/** 4-hour reminder, measured from the request timestamp (PRD 5.5). */
export async function processApprovalReminders(now = new Date()) {
  const due = await prisma.approvalRequest.findMany({
    where: {
      status: 'pending',
      reminderSentAt: null,
      requestedAt: { lte: new Date(now.getTime() - REMINDER_AFTER_MS) },
    },
    include: { conversation: true },
  });
  if (approvalTestHooks.afterReminderSelection) await approvalTestHooks.afterReminderSelection();
  let sent = 0;
  for (const request of due) {
    // Claim before dispatch so overlapping workers cannot both email the Lead.
    const claim = await prisma.approvalRequest.updateMany({
      where: { id: request.id, status: 'pending', reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    if (claim.count === 0) continue;
    const result = await sendTransactionalEmail({
      to: request.sentToEmail,
      subject: `Reminder — sign-off waiting: ${request.conversation.subject}`,
      html: approvalEmailHtml({
        draft: request.draftSnapshot,
        originalReply: null,
        subject: request.conversation.subject,
        approveUrl: `${env.API_PUBLIC_URL}/api/approvals/${request.approveToken}/approve`,
        changesUrl: `${env.API_PUBLIC_URL}/api/approvals/${request.changesToken}/changes`,
        reminder: true,
      }),
    });
    if (result.delivered) sent += 1;
    else if (result.retryable) {
      // Release the claim so a later tick can retry a transient provider failure.
      await prisma.approvalRequest.updateMany({
        where: { id: request.id, reminderSentAt: now },
        data: { reminderSentAt: null },
      });
    }
  }
  return sent;
}

function page(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reply Dashboard</title></head>
<body style="font-family:sans-serif;background:#f7f5ee;display:grid;place-items:center;min-height:90vh;margin:0">
  <div style="background:#fff;border-radius:12px;padding:28px;max-width:520px;box-shadow:0 8px 32px rgba(22,58,36,.08)">${body}</div>
</body></html>`;
}
