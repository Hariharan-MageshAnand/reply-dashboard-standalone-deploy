import type {
  ApprovalView,
  ClassificationView,
  ConversationDetail,
  ConversationListItem,
  ConversationListResponse,
  ConversationParticipant,
  MessageView,
  ReplyDraft,
  ReplyLabel,
  SendState,
  SenderMailbox,
} from '@reply/contracts';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

function mapParticipant(p: {
  email: string;
  name: string | null;
  role: string;
}): ConversationParticipant {
  return {
    email: p.email,
    name: p.name,
    role: (['from', 'to', 'cc', 'bcc'].includes(p.role) ? p.role : 'to') as ConversationParticipant['role'],
  };
}

function mapListItem(row: {
  id: string;
  mailboxId: string;
  subject: string;
  snippet: string;
  unread: boolean;
  status: ConversationListItem['status'];
  replyStatus: ConversationListItem['replyStatus'];
  snoozedUntil: Date | null;
  currentLabel: ReplyLabel | null;
  isWarmup: boolean;
  slaBreachedAt: Date | null;
  lastMessageAt: Date;
  messageCount: number;
  mailbox: { email: string };
  participants: Array<{ email: string; name: string | null; role: string }>;
  labels: Array<{ label: { name: string } }>;
  assignment: { assigneeId: string; assignee: { fullName: string | null; email: string } } | null;
  outreachCampaign: { name: string } | null;
  scheduledSends?: Array<{ scheduledFor: Date; status: string }>;
  classifications?: Array<{ messageId: string; extractedMetadata: unknown }>;
  messages?: Array<{ id: string; direction: string; sentAt: Date }>;
}): ConversationListItem {
  // Redirect chip data: the newest inbound message's extracted metadata.
  const newestInboundId = row.messages
    ?.filter((m) => m.direction === 'inbound')
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.id.localeCompare(a.id))[0]?.id;
  const meta = row.classifications?.find((c) => c.messageId === newestInboundId)
    ?.extractedMetadata as { redirect_contact_name?: string } | null | undefined;
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    mailboxEmail: row.mailbox.email,
    subject: row.subject,
    snippet: row.snippet,
    participants: row.participants.map(mapParticipant),
    unread: row.unread,
    status: row.status,
    replyStatus: row.replyStatus,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    scheduledFor:
      row.scheduledSends
        ?.find((s) => s.status === 'scheduled' || s.status === 'processing')
        ?.scheduledFor.toISOString() ?? null,
    label: row.currentLabel,
    redirectName: meta?.redirect_contact_name ?? null,
    isWarmup: row.isWarmup,
    slaBreachedAt: row.slaBreachedAt?.toISOString() ?? null,
    labels: row.labels.map((l) => l.label.name),
    assigneeId: row.assignment?.assigneeId ?? null,
    assigneeName: row.assignment?.assignee.fullName ?? row.assignment?.assignee.email ?? null,
    lastMessageAt: row.lastMessageAt.toISOString(),
    outreachCampaign: row.outreachCampaign?.name ?? null,
    messageCount: row.messageCount,
  };
}

export async function listMailboxes(workspaceId: string): Promise<SenderMailbox[]> {
  const rows = await prisma.senderMailbox.findMany({
    where: { workspaceId, disconnectedAt: null },
    include: {
      syncState: true,
      _count: {
        select: {
          conversations: { where: { unread: true } },
        },
      },
    },
    orderBy: { email: 'asc' },
  });

  return rows.map((row) => {
    const lag =
      row.syncState?.lastSyncedAt != null
        ? Math.max(0, Math.floor((Date.now() - row.syncState.lastSyncedAt.getTime()) / 1000))
        : null;
    const capabilities: SenderMailbox['capabilities'] = [];
    if (row.canRead) capabilities.push('read');
    if (row.canModify) capabilities.push('modify');
    if (row.canSend) capabilities.push('send');
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      provider: row.provider,
      health: row.health,
      capabilities,
      unreadCount: row._count.conversations,
      lastSyncedAt: row.syncState?.lastSyncedAt?.toISOString() ?? null,
      syncLagSeconds: lag,
      lastError: row.lastError,
      connectedAt: row.connectedAt.toISOString(),
    };
  });
}

export async function listConversations(
  workspaceId: string,
  filters: {
    mailboxId?: string;
    unread?: boolean;
    status?: ConversationListItem['status'];
    replyStatus?: ConversationListItem['replyStatus'];
    replyLabel?: ReplyLabel;
    label?: string;
    assigneeId?: string;
    q?: string;
    cursor?: string;
    limit?: number;
    warmup?: boolean;
  },
): Promise<ConversationListResponse> {
  const limit = Math.min(filters.limit ?? 30, 100);
  const where: Prisma.ConversationWhereInput = {
    workspaceId,
    mailbox: { disconnectedAt: null },
    // Warm-up noise is hidden everywhere except the explicit warm-up view.
    isWarmup: filters.warmup === true,
  };
  if (filters.mailboxId) where.mailboxId = filters.mailboxId;
  if (typeof filters.unread === 'boolean') where.unread = filters.unread;
  if (filters.status) where.status = filters.status;
  if (filters.replyStatus) where.replyStatus = filters.replyStatus;
  if (filters.replyLabel) where.currentLabel = filters.replyLabel;
  if (filters.assigneeId) where.assignment = { assigneeId: filters.assigneeId };
  if (filters.label) {
    where.labels = { some: { label: { name: filters.label, workspaceId } } };
  }
  if (filters.q) {
    where.OR = [
      { subject: { contains: filters.q, mode: 'insensitive' } },
      { snippet: { contains: filters.q, mode: 'insensitive' } },
      { participants: { some: { email: { contains: filters.q, mode: 'insensitive' } } } },
    ];
  }

  const [rows, totalUnread] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: {
        mailbox: true,
        participants: true,
        labels: { include: { label: true } },
        assignment: { include: { assignee: true } },
        outreachCampaign: true,
        scheduledSends: { where: { status: { in: ['scheduled', 'processing'] } }, take: 1 },
        classifications: { select: { messageId: true, extractedMetadata: true } },
        messages: {
          where: { direction: 'inbound' },
          select: { id: true, direction: true, sentAt: true },
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
      // PRD 5.1 ordering: Interested → More Info → Needs Review → the rest,
      // newest first within each group.
      orderBy: [{ labelPriority: 'asc' }, { lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    }),
    prisma.conversation.count({
      where: { workspaceId, unread: true, isWarmup: false, mailbox: { disconnectedAt: null } },
    }),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(mapListItem),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    totalUnread,
  };
}

function mapMessage(m: {
  id: string;
  gmailMessageId: string;
  direction: 'inbound' | 'outbound';
  fromEmail: string;
  fromName: string | null;
  toJson: unknown;
  ccJson: unknown;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  sentAt: Date;
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
}): MessageView {
  const to = (Array.isArray(m.toJson) ? m.toJson : []) as Array<{
    email: string;
    name: string | null;
  }>;
  const cc = (Array.isArray(m.ccJson) ? m.ccJson : []) as Array<{
    email: string;
    name: string | null;
  }>;
  return {
    id: m.id,
    gmailMessageId: m.gmailMessageId,
    direction: m.direction,
    from: { email: m.fromEmail, name: m.fromName, role: 'from' },
    to: to.map((p) => ({ email: p.email, name: p.name, role: 'to' as const })),
    cc: cc.map((p) => ({ email: p.email, name: p.name, role: 'cc' as const })),
    subject: m.subject,
    bodyHtml: m.bodyHtml,
    bodyText: m.bodyText,
    sentAt: m.sentAt.toISOString(),
    attachments: m.attachments,
  };
}

export async function getConversation(
  workspaceId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: {
      mailbox: true,
      participants: true,
      labels: { include: { label: true } },
      assignment: { include: { assignee: true } },
      outreachCampaign: true,
      draft: true,
      messages: {
        include: { attachments: true },
        orderBy: { sentAt: 'asc' },
      },
      outboundSends: { orderBy: { createdAt: 'desc' }, take: 1 },
      scheduledSends: { orderBy: { createdAt: 'desc' }, take: 1 },
      classifications: true,
      aiDrafts: { orderBy: { createdAt: 'desc' }, take: 1 },
      approvalRequests: {
        orderBy: { requestedAt: 'desc' },
        include: { comments: { orderBy: { createdAt: 'asc' } } },
      },
    },
  });
  if (!row) throw new AppError('not_found', 'Conversation not found.', 404);

  const draft: ReplyDraft | null = row.draft
    ? {
        id: row.draft.id,
        conversationId: row.draft.conversationId,
        bodyHtml: row.draft.bodyHtml,
        bodyText: row.draft.bodyText,
        updatedAt: row.draft.updatedAt.toISOString(),
      }
    : null;

  const latestSend = row.outboundSends[0] ?? null;
  const sendState: SendState = latestSend
    ? {
        status: latestSend.status,
        errorMessage: latestSend.status === 'failed' ? latestSend.errorMessage : null,
        updatedAt: latestSend.updatedAt.toISOString(),
      }
    : { status: 'idle', errorMessage: null, updatedAt: null };

  const latestScheduled = row.scheduledSends[0] ?? null;

  // The classification shown is the one belonging to the NEWEST inbound reply
  // (message chronology) — never just the most recently written row.
  const newestInbound = [...row.messages]
    .filter((m) => m.direction === 'inbound')
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.id.localeCompare(a.id))[0];
  const latestClassification = newestInbound
    ? (row.classifications.find((c) => c.messageId === newestInbound.id) ?? null)
    : null;
  const classification: ClassificationView | null = latestClassification
    ? {
        aiLabel: latestClassification.aiLabel,
        aiConfidence: latestClassification.aiConfidence,
        aiRationale: latestClassification.aiRationale,
        finalLabel: latestClassification.finalLabel,
        extractedMetadata:
          (latestClassification.extractedMetadata as ClassificationView['extractedMetadata']) ??
          null,
        corrected: latestClassification.correctedAt !== null,
        classifiedAt: latestClassification.createdAt.toISOString(),
      }
    : null;

  const latestAiDraft = row.aiDrafts[0] ?? null;

  const latestApproval = row.approvalRequests[0] ?? null;
  // Comments are append-only ACROSS request rounds (PRD 7.3): a re-request
  // must never hide earlier Lead feedback, so aggregate every request's
  // comments chronologically.
  const allApprovalComments = row.approvalRequests
    .flatMap((r) => r.comments)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const approval: ApprovalView | null = latestApproval
    ? {
        id: latestApproval.id,
        status: latestApproval.status,
        sentToEmail: latestApproval.sentToEmail,
        requestedAt: latestApproval.requestedAt.toISOString(),
        reminderSentAt: latestApproval.reminderSentAt?.toISOString() ?? null,
        resolvedAt: latestApproval.resolvedAt?.toISOString() ?? null,
        comments: allApprovalComments.map((c) => ({
          commentText: c.commentText,
          createdAt: c.createdAt.toISOString(),
        })),
        canOverride:
          latestApproval.status === 'pending' &&
          Date.now() - latestApproval.requestedAt.getTime() >= 24 * 3600_000,
      }
    : null;

  return {
    ...mapListItem(row),
    messages: row.messages.map(mapMessage),
    draft,
    sendState,
    scheduledSend: latestScheduled
      ? {
          id: latestScheduled.id,
          scheduledFor: latestScheduled.scheduledFor.toISOString(),
          // 'processing' is the processor's internal claim; to the operator
          // the message is still queued.
          status: latestScheduled.status === 'processing' ? 'scheduled' : latestScheduled.status,
          cancelReason: latestScheduled.cancelReason,
          errorMessage: latestScheduled.errorMessage,
          createdAt: latestScheduled.createdAt.toISOString(),
        }
      : null,
    classification,
    approval,
    latestAiDraft: latestAiDraft
      ? {
          id: latestAiDraft.id,
          draftText: latestAiDraft.draftText,
          instruction: latestAiDraft.instruction,
          isFallback: latestAiDraft.model === 'template_fallback',
          createdAt: latestAiDraft.createdAt.toISOString(),
        }
      : null,
  };
}

export async function updateConversationStatus(
  workspaceId: string,
  conversationId: string,
  status: ConversationListItem['status'],
  snoozedUntil: Date | null = null,
) {
  const updated = await prisma.conversation.updateMany({
    where: { id: conversationId, workspaceId },
    data: { status, snoozedUntil: status === 'snoozed' ? snoozedUntil : null },
  });
  if (!updated.count) throw new AppError('not_found', 'Conversation not found.', 404);
  return getConversation(workspaceId, conversationId);
}

/**
 * Reopens snoozed conversations whose snooze date has passed. Marked unread
 * and bumped to the top of the inbox (Gmail-style: resurfacing counts as
 * activity), so they surface without any manual action (SXP-69). Runs on the
 * maintenance scheduler (worker.ts).
 */
export async function resurfaceDueSnoozed(now = new Date()) {
  const result = await prisma.conversation.updateMany({
    where: { status: 'snoozed', snoozedUntil: { not: null, lte: now } },
    data: { status: 'open', snoozedUntil: null, unread: true, lastMessageAt: now },
  });
  return result.count;
}

export async function markConversationRead(
  workspaceId: string,
  conversationId: string,
  unread: boolean,
) {
  const updated = await prisma.conversation.updateMany({
    where: { id: conversationId, workspaceId },
    data: { unread },
  });
  if (!updated.count) throw new AppError('not_found', 'Conversation not found.', 404);
  return getConversation(workspaceId, conversationId);
}

export async function assignConversation(
  workspaceId: string,
  conversationId: string,
  assigneeId: string | null,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);

  if (!assigneeId) {
    await prisma.conversationAssignment.deleteMany({ where: { conversationId } });
  } else {
    const member = await prisma.workspaceMember.findFirst({
      where: { workspaceId, userId: assigneeId },
    });
    if (!member) throw new AppError('validation_error', 'Assignee is not in this workspace.', 400);
    await prisma.conversationAssignment.upsert({
      where: { conversationId },
      create: { conversationId, assigneeId },
      update: { assigneeId, assignedAt: new Date() },
    });
  }
  return getConversation(workspaceId, conversationId);
}

export async function setConversationLabels(
  workspaceId: string,
  conversationId: string,
  labels: string[],
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);

  const defs = [];
  for (const name of labels) {
    const def = await prisma.conversationLabelDef.upsert({
      where: { workspaceId_name: { workspaceId, name } },
      create: { workspaceId, name },
      update: {},
    });
    defs.push(def);
  }

  await prisma.conversationLabel.deleteMany({ where: { conversationId } });
  if (defs.length) {
    await prisma.conversationLabel.createMany({
      data: defs.map((d) => ({ conversationId, labelId: d.id })),
    });
  }
  return getConversation(workspaceId, conversationId);
}

export async function saveDraft(
  workspaceId: string,
  conversationId: string,
  authorId: string,
  bodyHtml: string,
  bodyText: string,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);

  const draft = await prisma.replyDraft.upsert({
    where: { conversationId },
    create: { conversationId, authorId, bodyHtml, bodyText },
    update: { bodyHtml, bodyText, authorId },
  });

  return {
    id: draft.id,
    conversationId: draft.conversationId,
    bodyHtml: draft.bodyHtml,
    bodyText: draft.bodyText,
    updatedAt: draft.updatedAt.toISOString(),
  } satisfies ReplyDraft;
}
