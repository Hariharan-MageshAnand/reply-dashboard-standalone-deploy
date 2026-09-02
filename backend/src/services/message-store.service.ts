import type { MessageDirection, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getWarmupKeywords, matchesWarmupKeywords } from './warmup.service.js';

export type ParticipantInput = { email: string; name: string | null; role: string };

export interface ConversationMessageInput {
  workspaceId: string;
  mailboxId: string;
  mailboxEmail: string;
  gmailThreadId: string;
  gmailMessageId: string;
  direction: MessageDirection;
  subject: string;
  snippet: string;
  bodyHtml: string | null;
  bodyText: string | null;
  fromEmail: string;
  fromName: string | null;
  to: ParticipantInput[];
  cc: ParticipantInput[];
  sentAt: Date;
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  unread: boolean;
}

// Outbound messages recorded at send time (before the provider assigns an id)
// use a local placeholder id; sync later reconciles them to the real provider id.
export const LOCAL_OUTBOUND_PREFIX = 'local-out-';

async function adoptLocalPlaceholder(input: ConversationMessageInput, conversationId: string) {
  if (input.direction !== 'outbound') return null;
  const placeholder = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: 'outbound',
      gmailMessageId: { startsWith: LOCAL_OUTBOUND_PREFIX },
      sentAt: {
        gte: new Date(input.sentAt.getTime() - 10 * 60_000),
        lte: new Date(input.sentAt.getTime() + 10 * 60_000),
      },
    },
  });
  if (!placeholder) return null;
  return prisma.message.update({
    where: { id: placeholder.id },
    data: {
      gmailMessageId: input.gmailMessageId,
      rfcMessageId: input.rfcMessageId ?? placeholder.rfcMessageId,
      bodyHtml: input.bodyHtml ?? placeholder.bodyHtml,
      bodyText: input.bodyText ?? placeholder.bodyText,
    },
  });
}

export async function upsertConversationMessage(input: ConversationMessageInput) {
  const conversation = await prisma.conversation.upsert({
    where: {
      mailboxId_gmailThreadId: {
        mailboxId: input.mailboxId,
        gmailThreadId: input.gmailThreadId,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      gmailThreadId: input.gmailThreadId,
      subject: input.subject || '(no subject)',
      snippet: input.snippet,
      unread: input.unread,
      status: 'open',
      replyStatus: input.direction === 'inbound' ? 'awaiting_reply' : 'replied',
      lastMessageAt: input.sentAt,
      messageCount: 1,
    },
    update: {
      subject: input.subject || undefined,
      snippet: input.snippet,
      unread: input.unread ? true : undefined,
      lastMessageAt: input.sentAt,
      replyStatus: input.direction === 'inbound' ? 'awaiting_reply' : 'replied',
      // An outbound message (from any client, incl. synced sends) clears the
      // SLA breach tag (PRD 5.8).
      ...(input.direction === 'outbound' ? { slaBreachedAt: null } : {}),
    },
  });

  const existing = await prisma.message.findUnique({
    where: {
      mailboxId_gmailMessageId: {
        mailboxId: input.mailboxId,
        gmailMessageId: input.gmailMessageId,
      },
    },
  });

  if (existing) {
    if (input.rfcMessageId && !existing.rfcMessageId) {
      await prisma.message.update({
        where: { id: existing.id },
        data: { rfcMessageId: input.rfcMessageId },
      });
    }
    return { conversation, created: false, messageId: existing.id, isWarmup: conversation.isWarmup };
  }

  const adopted = await adoptLocalPlaceholder(input, conversation.id);
  if (adopted) {
    return { conversation, created: false, messageId: adopted.id, isWarmup: conversation.isWarmup };
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      mailboxId: input.mailboxId,
      gmailMessageId: input.gmailMessageId,
      gmailThreadId: input.gmailThreadId,
      direction: input.direction,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      toJson: input.to as unknown as Prisma.InputJsonValue,
      ccJson: input.cc as unknown as Prisma.InputJsonValue,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      rfcMessageId: input.rfcMessageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      referencesHeader: input.referencesHeader ?? null,
      sentAt: input.sentAt,
    },
  });

  const participants: ParticipantInput[] = [
    { email: input.fromEmail, name: input.fromName, role: 'from' },
    ...input.to.map((p) => ({ ...p, role: 'to' })),
    ...input.cc.map((p) => ({ ...p, role: 'cc' })),
  ];

  await prisma.conversationParticipant.deleteMany({ where: { conversationId: conversation.id } });
  if (participants.length) {
    await prisma.conversationParticipant.createMany({
      data: participants.map((p) => ({
        conversationId: conversation.id,
        email: p.email,
        name: p.name,
        role: p.role,
      })),
    });
  }

  const messageCount = await prisma.message.count({ where: { conversationId: conversation.id } });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { messageCount },
  });

  // Warm-up/test-email noise: flag matching threads so they stay out of the
  // inbox and skip AI classification.
  let isWarmup = conversation.isWarmup;
  if (!isWarmup && input.direction === 'inbound') {
    const keywords = await getWarmupKeywords(input.workspaceId);
    if (matchesWarmupKeywords(keywords, input.subject, input.bodyText)) {
      isWarmup = true;
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { isWarmup: true, unread: false },
      });
    }
  }

  if (input.direction === 'inbound') {
    // A fresh reply changes the situation — a queued message written for the
    // old context must not fire. Cancel it, restore its content as a draft for
    // review, and flag the conversation rather than discarding silently (PRD 5.7).
    const pending = await prisma.scheduledSend.findFirst({
      where: { conversationId: conversation.id, status: 'scheduled' },
    });
    // Status-guarded: if the due-send processor claimed the row ('processing')
    // or already sent it between our read and this write, the cancel loses and
    // must not overwrite that state (or resurrect the content as a draft).
    const cancelled = pending
      ? await prisma.scheduledSend.updateMany({
          where: { id: pending.id, status: 'scheduled' },
          data: { status: 'cancelled', cancelReason: 'auto_cancelled_new_reply' },
        })
      : null;
    if (pending && cancelled && cancelled.count > 0) {
      await prisma.replyDraft.upsert({
        where: { conversationId: conversation.id },
        create: {
          conversationId: conversation.id,
          authorId: pending.authorId,
          bodyHtml: pending.bodyHtml,
          bodyText: pending.bodyText,
        },
        update: { bodyHtml: pending.bodyHtml, bodyText: pending.bodyText },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { unread: true, replyStatus: 'needs_attention' },
      });
    }
  }

  return { conversation, created: true, messageId: message.id, isWarmup };
}
