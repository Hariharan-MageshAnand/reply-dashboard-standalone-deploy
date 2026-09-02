import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { reclassifyFallback } from '../../scripts/reclassify-fallback.js';

describe('reclassify-fallback recovery script', () => {
  const app = createApp();

  async function makeConversation(input: {
    workspaceId: string;
    mailboxId: string;
    mailboxEmail: string;
    key: string;
    isWarmup: boolean;
  }) {
    const threadId = `rf-${input.key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId: input.workspaceId,
        mailboxId: input.mailboxId,
        gmailThreadId: threadId,
        subject: 'Re: intro',
        snippet: 'hello',
        isWarmup: input.isWarmup,
        lastMessageAt: new Date(),
        messageCount: 1,
      },
    });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        mailboxId: input.mailboxId,
        gmailMessageId: `rf-msg-${threadId}`,
        gmailThreadId: threadId,
        direction: 'inbound',
        fromEmail: 'prospect@example.com',
        fromName: 'Prospect',
        toJson: [{ email: input.mailboxEmail, name: null }],
        subject: 'Re: intro',
        bodyText: 'hello there',
        sentAt: new Date(),
      },
    });
    // A no-key fallback classification: model NULL, never corrected.
    const classification = await prisma.replyClassification.create({
      data: {
        conversationId: conversation.id,
        messageId: message.id,
        aiLabel: 'needs_review',
        aiConfidence: 0,
        finalLabel: 'needs_review',
        aiRationale: 'Classifier unavailable — routed to manual review.',
      },
    });
    return { conversation, message, classification };
  }

  it('leaves warm-up fallback rows untouched while replacing eligible ones', async () => {
    const email = `reclass-${Date.now()}@emsoft.com`;
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    const mailboxId = mailbox.body.id as string;
    const mailboxEmail = `outreach-${email}`;

    const warm = await makeConversation({
      workspaceId, mailboxId, mailboxEmail, key: 'warm', isWarmup: true,
    });
    const normal = await makeConversation({
      workspaceId, mailboxId, mailboxEmail, key: 'normal', isWarmup: false,
    });

    const result = await reclassifyFallback({ workspaceId });

    // The warm-up conversation was skipped AND kept its original row — the
    // exact row, not a recreation.
    expect(result.skippedWarmup).toBe(1);
    const warmRow = await prisma.replyClassification.findUnique({
      where: { id: warm.classification.id },
    });
    expect(warmRow).not.toBeNull();

    // The eligible conversation's fallback row was replaced: old row gone,
    // a classification exists for its newest inbound.
    expect(result.deleted).toBe(1);
    expect(result.conversations).toBe(1);
    expect(result.failed).toBe(0);
    expect(
      await prisma.replyClassification.findUnique({ where: { id: normal.classification.id } }),
    ).toBeNull();
    expect(
      await prisma.replyClassification.findUnique({ where: { messageId: normal.message.id } }),
    ).not.toBeNull();
  });

  it('replaces every fallback row in a conversation, not only the newest inbound', async () => {
    const email = `reclass-multi-${Date.now()}@emsoft.com`;
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    const mailboxId = mailbox.body.id as string;
    const mailboxEmail = `outreach-${email}`;

    const first = await makeConversation({
      workspaceId, mailboxId, mailboxEmail, key: 'multi', isWarmup: false,
    });
    const olderMessageId = first.message.id;
    const newer = await prisma.message.create({
      data: {
        conversationId: first.conversation.id,
        mailboxId,
        gmailMessageId: `rf-msg-newer-${first.conversation.gmailThreadId}`,
        gmailThreadId: first.conversation.gmailThreadId,
        direction: 'inbound',
        fromEmail: 'prospect@example.com',
        fromName: 'Prospect',
        toJson: [{ email: mailboxEmail, name: null }],
        subject: 'Re: intro',
        bodyText: 'following up',
        sentAt: new Date(Date.now() + 60_000),
      },
    });
    const newerClassification = await prisma.replyClassification.create({
      data: {
        conversationId: first.conversation.id,
        messageId: newer.id,
        aiLabel: 'needs_review',
        aiConfidence: 0,
        finalLabel: 'needs_review',
        aiRationale: 'Classifier unavailable — routed to manual review.',
      },
    });

    const result = await reclassifyFallback({ workspaceId });

    expect(result.deleted).toBe(2);
    expect(result.conversations).toBe(1);
    expect(result.reclassified).toBe(2);
    expect(result.failed).toBe(0);
    expect(
      await prisma.replyClassification.findUnique({ where: { id: first.classification.id } }),
    ).toBeNull();
    expect(
      await prisma.replyClassification.findUnique({ where: { id: newerClassification.id } }),
    ).toBeNull();
    expect(
      await prisma.replyClassification.findUnique({ where: { messageId: olderMessageId } }),
    ).not.toBeNull();
    expect(
      await prisma.replyClassification.findUnique({ where: { messageId: newer.id } }),
    ).not.toBeNull();
  });

  it('restores a fallback row when classify throws instead of leaving a gap', async () => {
    const email = `reclass-restore-${Date.now()}@emsoft.com`;
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    const mailboxId = mailbox.body.id as string;
    const mailboxEmail = `outreach-${email}`;

    const first = await makeConversation({
      workspaceId, mailboxId, mailboxEmail, key: 'restore', isWarmup: false,
    });
    const original = await prisma.replyClassification.findUniqueOrThrow({
      where: { id: first.classification.id },
    });

    const result = await reclassifyFallback({
      workspaceId,
      classify: async (messageId) => {
        if (messageId === first.message.id) {
          throw new Error('forced classify failure');
        }
        return { finalLabel: 'interested' as const };
      },
    });

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(0);
    const restored = await prisma.replyClassification.findUnique({
      where: { id: original.id },
    });
    expect(restored).not.toBeNull();
    expect(restored?.messageId).toBe(original.messageId);
    expect(restored?.aiRationale).toBe(original.aiRationale);
    expect(restored?.model).toBeNull();
    expect(restored?.finalLabel).toBe(original.finalLabel);
  });
});
