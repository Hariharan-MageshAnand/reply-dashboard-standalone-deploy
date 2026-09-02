import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { tagSlaBreaches } from './sla.service.js';

describe('SLA breach tagging (PRD 5.8)', () => {
  const app = createApp();

  async function setup(email: string, opts: { ageMinutes: number; isWarmup?: boolean }) {
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    const mailboxId = mailbox.body.id as string;
    const threadId = `sla-${email}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        mailboxId,
        gmailThreadId: threadId,
        subject: 'Re: intro',
        snippet: 'waiting on us',
        replyStatus: 'awaiting_reply',
        isWarmup: opts.isWarmup ?? false,
        lastMessageAt: new Date(Date.now() - opts.ageMinutes * 60_000),
        messageCount: 1,
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        mailboxId,
        gmailMessageId: `msg-${threadId}`,
        gmailThreadId: threadId,
        direction: 'inbound',
        fromEmail: 'prospect@example.com',
        fromName: 'Prospect',
        toJson: [{ email: `outreach-${email}`, name: null }],
        subject: 'Re: intro',
        bodyText: 'still waiting…',
        sentAt: new Date(Date.now() - opts.ageMinutes * 60_000),
      },
    });
    return { auth, workspaceId, conversationId: conversation.id };
  }

  it('tags replies waiting past the threshold; fresh and warm-up threads are untouched', async () => {
    const stale = await setup('sla1@emsoft.com', { ageMinutes: 90 });
    const fresh = await setup('sla2@emsoft.com', { ageMinutes: 10 });
    const noise = await setup('sla3@emsoft.com', { ageMinutes: 90, isWarmup: true });

    await tagSlaBreaches();

    const staleRow = await prisma.conversation.findUniqueOrThrow({
      where: { id: stale.conversationId },
    });
    expect(staleRow.slaBreachedAt).not.toBeNull();

    const freshRow = await prisma.conversation.findUniqueOrThrow({
      where: { id: fresh.conversationId },
    });
    expect(freshRow.slaBreachedAt).toBeNull();

    const noiseRow = await prisma.conversation.findUniqueOrThrow({
      where: { id: noise.conversationId },
    });
    expect(noiseRow.slaBreachedAt).toBeNull();

    // The tag is exposed on the list item for the UI badge.
    const list = await request(app).get('/api/conversations').set('Authorization', stale.auth);
    expect(list.body.items[0].slaBreachedAt).not.toBeNull();
  });

  it('respects the workspace-configured threshold', async () => {
    const { auth, conversationId } = await setup('sla4@emsoft.com', { ageMinutes: 45 });

    // Reset to the default — the workspace persists across test runs.
    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ slaMinutes: 60 })
      .expect(200);

    // At 60min: a 45-minute wait is not a breach.
    await tagSlaBreaches();
    let row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.slaBreachedAt).toBeNull();

    // Tighten to 30min: now it is.
    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ slaMinutes: 30 })
      .expect(200);
    await tagSlaBreaches();
    row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.slaBreachedAt).not.toBeNull();
  });

  it('clears the tag when a response goes out', async () => {
    const { auth, conversationId } = await setup('sla5@emsoft.com', { ageMinutes: 120 });
    await tagSlaBreaches();

    await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({
        bodyHtml: '<p>sorry for the wait!</p>',
        bodyText: 'sorry for the wait!',
        idempotencyKey: `sla-clear-${conversationId}`,
      })
      .expect(201);

    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.slaBreachedAt).toBeNull();
  });
});
