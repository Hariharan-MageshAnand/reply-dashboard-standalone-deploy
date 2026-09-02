import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  classifyInboundMessage,
  correctConversationLabel,
  generateConversationDraft,
  labelPriority,
  aiTestHooks,
  escapeHtml,
} from './ai.service.js';

// Tests run with ANTHROPIC_API_KEY unset (vitest.config.ts), so these exercise
// the PRD-mandated fallback paths: classify-failure → needs_review, draft
// failure → template. The live-API paths share all surrounding logic.
describe('AI layer (fallback mode)', () => {
  const app = createApp();

  async function setup(email: string) {
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const userId = login.body.bootstrap.user.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    const mailboxId = mailbox.body.id as string;
    const threadId = `ai-thread-${email}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        mailboxId,
        gmailThreadId: threadId,
        subject: 'Re: intro',
        snippet: 'Sounds interesting, can we talk?',
        replyStatus: 'awaiting_reply',
        lastMessageAt: new Date(),
        messageCount: 1,
      },
    });
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        mailboxId,
        gmailMessageId: `ai-msg-${threadId}`,
        gmailThreadId: threadId,
        direction: 'inbound',
        fromEmail: 'prospect@example.com',
        fromName: 'Pat Prospect',
        toJson: [{ email: `outreach-${email}`, name: null }],
        subject: 'Re: intro',
        bodyText: 'Sounds interesting, can we talk next week?',
        sentAt: new Date(),
      },
    });
    return { auth, workspaceId, userId, conversationId: conversation.id, messageId: message.id };
  }

  it('classify failure routes to needs_review, never dropped, and is immutable', async () => {
    const { conversationId, messageId } = await setup('ai1@emsoft.com');

    const first = await classifyInboundMessage(messageId);
    expect(first.aiLabel).toBe('needs_review');
    expect(first.finalLabel).toBe('needs_review');
    expect(first.aiConfidence).toBe(0);

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.currentLabel).toBe('needs_review');
    expect(conversation.labelPriority).toBe(labelPriority('needs_review'));

    // Idempotent: re-running returns the same row, ai_label never overwritten.
    const second = await classifyInboundMessage(messageId);
    expect(second.id).toBe(first.id);
    expect(await prisma.replyClassification.count({ where: { messageId } })).toBe(1);
  });

  it('operator correction updates final_label but preserves ai_label', async () => {
    const { auth, workspaceId, userId, conversationId, messageId } = await setup('ai2@emsoft.com');
    await classifyInboundMessage(messageId);

    await correctConversationLabel(workspaceId, conversationId, 'interested', userId);

    const row = await prisma.replyClassification.findUniqueOrThrow({ where: { messageId } });
    expect(row.aiLabel).toBe('needs_review'); // immutable
    expect(row.finalLabel).toBe('interested');
    expect(row.correctedById).toBe(userId);
    expect(row.correctedAt).not.toBeNull();

    const detail = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set('Authorization', auth);
    expect(detail.body.label).toBe('interested');
    expect(detail.body.classification.corrected).toBe(true);
    expect(detail.body.classification.aiLabel).toBe('needs_review');
  });

  it('a correction of an older reply cannot overwrite a newer reply\'s current label', async () => {
    const { workspaceId, userId, conversationId, messageId: olderMessageId } =
      await setup('ai-correct-race@emsoft.com');
    await classifyInboundMessage(olderMessageId);
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    aiTestHooks.afterCorrectionSelect = async () => {
      aiTestHooks.afterCorrectionSelect = undefined;
      const newer = await prisma.message.create({
        data: {
          conversationId,
          mailboxId: conversation.mailboxId,
          gmailMessageId: `ai-correct-newer-${conversationId}`,
          gmailThreadId: conversation.gmailThreadId,
          direction: 'inbound',
          fromEmail: 'prospect@example.com',
          fromName: 'Pat Prospect',
          toJson: [{ email: 'outreach-ai-correct-race@emsoft.com', name: null }],
          subject: 'Re: intro',
          bodyText: 'Yes — let us talk, I am interested.',
          sentAt: new Date(Date.now() + 60_000),
        },
      });
      await classifyInboundMessage(newer.id);
    };
    try {
      await correctConversationLabel(workspaceId, conversationId, 'not_interested', userId);
    } finally {
      aiTestHooks.afterCorrectionSelect = undefined;
    }

    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(after.currentLabel).toBe('needs_review');
    expect(after.labelPriority).toBe(labelPriority('needs_review'));
    const older = await prisma.replyClassification.findUniqueOrThrow({
      where: { messageId: olderMessageId },
    });
    expect(older.finalLabel).toBe('not_interested');
    expect(older.correctedById).toBe(userId);
  });

  it('interested conversations sort ahead of others in the inbox (PRD 5.1)', async () => {
    const { auth, workspaceId, userId, conversationId, messageId } = await setup('ai3@emsoft.com');
    await classifyInboundMessage(messageId);
    // A second, newer conversation left at default priority.
    const mailboxId = (
      await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })
    ).mailboxId;
    await prisma.conversation.create({
      data: {
        workspaceId,
        mailboxId,
        gmailThreadId: `ai-thread-later-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        subject: 'Newer but unclassified',
        snippet: 'newest',
        lastMessageAt: new Date(Date.now() + 60_000),
        messageCount: 1,
      },
    });
    await correctConversationLabel(workspaceId, conversationId, 'interested', userId);

    const list = await request(app).get('/api/conversations').set('Authorization', auth);
    expect(list.body.items[0].id).toBe(conversationId);
    expect(list.body.items[0].label).toBe('interested');
  });

  it('a late-finishing classify job for an OLDER reply never overwrites the newer label', async () => {
    const { auth, conversationId, messageId: olderMessageId } = await setup('ai5@emsoft.com');
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    // A newer inbound reply arrives and its classify job completes FIRST
    // (simulated: classification row present, conversation labelled from it).
    const newer = await prisma.message.create({
      data: {
        conversationId,
        mailboxId: conversation.mailboxId,
        gmailMessageId: `ai5-newer-${conversationId}`,
        gmailThreadId: conversation.gmailThreadId,
        direction: 'inbound',
        fromEmail: 'prospect@example.com',
        fromName: 'Pat Prospect',
        toJson: [{ email: 'outreach-ai5@emsoft.com', name: null }],
        subject: 'Re: intro',
        bodyText: 'Actually yes — let us talk, I am interested.',
        sentAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.replyClassification.create({
      data: {
        conversationId,
        messageId: newer.id,
        aiLabel: 'interested',
        aiConfidence: 0.95,
        finalLabel: 'interested',
        aiRationale: 'Clear yes.',
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { currentLabel: 'interested', labelPriority: labelPriority('interested') },
    });

    // The OLDER reply's classify job finishes last (fallback -> needs_review).
    await classifyInboundMessage(olderMessageId);

    // The conversation keeps the NEWER reply's label…
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(after.currentLabel).toBe('interested');
    expect(after.labelPriority).toBe(labelPriority('interested'));
    // …the older reply's classification still exists (audit)…
    expect(
      await prisma.replyClassification.count({ where: { messageId: olderMessageId } }),
    ).toBe(1);
    // …and the detail view shows the newest reply's classification, even though
    // the older row was written later.
    const detail = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set('Authorization', auth);
    expect(detail.body.classification.finalLabel).toBe('interested');
  });

  it('concurrent classifications of one message resolve to the same row, never a constraint error', async () => {
    const { conversationId, messageId } = await setup('ai7@emsoft.com');

    // Worker job and manual "Classify now" racing for the same message: both
    // may pass the existence check before either creates. Neither caller may
    // fail — the loser gets the winner's immutable row.
    const [a, b] = await Promise.all([
      classifyInboundMessage(messageId),
      classifyInboundMessage(messageId),
    ]);
    expect(a.id).toBe(b.id);
    expect(await prisma.replyClassification.count({ where: { messageId } })).toBe(1);

    // The conversation label was applied exactly once, by the creator.
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.currentLabel).toBe('needs_review');
  });

  it('Classify now targets the canonical newest inbound when sentAt ties', async () => {
    const { auth, conversationId } = await setup('ai6@emsoft.com');
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    // Two inbound replies sharing one sentAt — only the id tie-breaker decides
    // which is canonical, and every consumer must agree on it.
    const tiedAt = new Date(Date.now() + 60_000);
    const twins = [];
    for (const suffix of ['a', 'b']) {
      twins.push(
        await prisma.message.create({
          data: {
            conversationId,
            mailboxId: conversation.mailboxId,
            gmailMessageId: `ai6-tied-${suffix}-${conversationId}`,
            gmailThreadId: conversation.gmailThreadId,
            direction: 'inbound',
            fromEmail: 'prospect@example.com',
            fromName: 'Pat Prospect',
            toJson: [{ email: 'outreach-ai6@emsoft.com', name: null }],
            subject: 'Re: intro',
            bodyText: `Tied reply ${suffix}`,
            sentAt: tiedAt,
          },
        }),
      );
    }
    // Same rule the services use: sentAt DESC, id DESC.
    const canonical = [...twins].sort((a, b) => (a.id > b.id ? -1 : 1))[0];

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/classify`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);

    // The classification landed on the id-desc winner, not a tie loser…
    expect(
      await prisma.replyClassification.count({ where: { messageId: canonical.id } }),
    ).toBe(1);
    // …so the detail view the route returned exposes it instead of null.
    expect(res.body.classification).not.toBeNull();
    expect(res.body.classification.finalLabel).toBe('needs_review');
  });

  it('draft generation falls back to a template, never a blank editor', async () => {
    const { auth, workspaceId, userId, conversationId } = await setup('ai4@emsoft.com');

    const aiDraft = await generateConversationDraft({
      workspaceId,
      conversationId,
      authorId: userId,
    });
    expect(aiDraft.model).toBe('template_fallback');
    expect(aiDraft.draftText.length).toBeGreaterThan(20);
    expect(aiDraft.draftText).toContain('Pat'); // prospect first name

    const detail = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set('Authorization', auth);
    expect(detail.body.draft.bodyText).toBe(aiDraft.draftText);
    expect(detail.body.latestAiDraft.isFallback).toBe(true);

    // Regenerate with an instruction records a fresh immutable AiDraft row.
    await request(app)
      .post(`/api/conversations/${conversationId}/generate-draft`)
      .set('Authorization', auth)
      .send({ instruction: 'make it shorter' })
      .expect(201);
    expect(await prisma.aiDraft.count({ where: { conversationId } })).toBe(2);
  });

  it('HTML-escapes model draft text before persisting bodyHtml', async () => {
    const { workspaceId, userId, conversationId } = await setup('ai-xss@emsoft.com');
    const payload = '</p><img src=x onerror=alert(1)><p>';
    aiTestHooks.draftTextOverride = payload;
    try {
      await generateConversationDraft({
        workspaceId,
        conversationId,
        authorId: userId,
      });
    } finally {
      delete aiTestHooks.draftTextOverride;
    }

    const draft = await prisma.replyDraft.findUniqueOrThrow({ where: { conversationId } });
    expect(draft.bodyText).toBe(payload);
    expect(draft.bodyHtml).toBe(`<p>${escapeHtml(payload)}</p>`);
    expect(draft.bodyHtml).not.toMatch(/<img/i);
  });
});
