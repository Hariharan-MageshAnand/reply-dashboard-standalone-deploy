import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { matchesWarmupKeywords } from './warmup.service.js';
import { upsertConversationMessage } from './message-store.service.js';

describe('matchesWarmupKeywords', () => {
  it('matches case-insensitively across subject and body', () => {
    expect(matchesWarmupKeywords(['Warm-Up'], 'Re: warm-up thread', null)).toBe(true);
    expect(matchesWarmupKeywords(['warmup'], 'Re: intro', 'this is a WARMUP test')).toBe(true);
    expect(matchesWarmupKeywords(['warmup'], 'Re: intro', 'genuine reply')).toBe(false);
    expect(matchesWarmupKeywords([], 'warmup', 'warmup')).toBe(false);
    expect(matchesWarmupKeywords(['  '], 'warmup', null)).toBe(false);
  });
});

describe('warm-up filtering (integration)', () => {
  const app = createApp();

  async function setup(email: string) {
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    return { auth, workspaceId, mailboxId: mailbox.body.id as string };
  }

  function ingest(input: {
    workspaceId: string;
    mailboxId: string;
    mailboxEmail: string;
    threadId: string;
    subject: string;
    bodyText: string;
  }) {
    return upsertConversationMessage({
      workspaceId: input.workspaceId,
      mailboxId: input.mailboxId,
      mailboxEmail: input.mailboxEmail,
      gmailThreadId: input.threadId,
      gmailMessageId: `msg-${input.threadId}`,
      direction: 'inbound',
      subject: input.subject,
      snippet: input.bodyText.slice(0, 140),
      bodyHtml: null,
      bodyText: input.bodyText,
      fromEmail: 'prospect@example.com',
      fromName: 'Prospect',
      to: [{ email: input.mailboxEmail, name: null, role: 'to' }],
      cc: [],
      sentAt: new Date(),
      unread: true,
    });
  }

  it('flags matching threads at ingestion, hides them from the inbox, and shows them in the warm-up view', async () => {
    const { auth, workspaceId, mailboxId } = await setup('warm1@emsoft.com');
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ warmupKeywords: ['warmup probe'] })
      .expect(200);

    const noise = await ingest({
      workspaceId,
      mailboxId,
      mailboxEmail: 'outreach-warm1@emsoft.com',
      threadId: `wu-noise-${runId}`,
      subject: 'Automated warmup probe 123',
      bodyText: 'keeping deliverability healthy',
    });
    expect(noise.isWarmup).toBe(true);

    const real = await ingest({
      workspaceId,
      mailboxId,
      mailboxEmail: 'outreach-warm1@emsoft.com',
      threadId: `wu-real-${runId}`,
      subject: 'Re: intro',
      bodyText: 'Interested, tell me more',
    });
    expect(real.isWarmup).toBe(false);

    const inbox = await request(app).get('/api/conversations').set('Authorization', auth);
    const inboxThreads = inbox.body.items.map((i: { subject: string }) => i.subject);
    expect(inboxThreads).toContain('Re: intro');
    expect(inboxThreads).not.toContain('Automated warmup probe 123');

    const warmupView = await request(app)
      .get('/api/conversations?warmup=true')
      .set('Authorization', auth);
    expect(warmupView.body.items.map((i: { subject: string }) => i.subject)).toContain(
      'Automated warmup probe 123',
    );
  });

  it('re-applies keywords to existing threads in both directions on save', async () => {
    const { auth, workspaceId, mailboxId } = await setup('warm2@emsoft.com');
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Ingested before any keywords exist → visible.
    const stored = await ingest({
      workspaceId,
      mailboxId,
      mailboxEmail: 'outreach-warm2@emsoft.com',
      threadId: `wu-retro-${runId}`,
      subject: 'Deliverability check XYZ',
      bodyText: 'noise',
    });
    expect(stored.isWarmup).toBe(false);

    // Adding a matching keyword hides it retroactively…
    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ warmupKeywords: ['deliverability check'] })
      .expect(200);
    let row = await prisma.conversation.findUniqueOrThrow({
      where: { id: stored.conversation.id },
    });
    expect(row.isWarmup).toBe(true);

    // …and clearing keywords restores it.
    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ warmupKeywords: [] })
      .expect(200);
    row = await prisma.conversation.findUniqueOrThrow({ where: { id: stored.conversation.id } });
    expect(row.isWarmup).toBe(false);
  });

  it('retroactive filtering matches keywords that only appear past the snippet boundary', async () => {
    const { auth, workspaceId, mailboxId } = await setup('warm3@emsoft.com');
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // The keyword sits beyond character 140, so neither the subject nor the
    // stored 140-char snippet contains it — only the full body does. This is
    // exactly what ingestion matches on, so the retroactive pass must too.
    const filler = 'A perfectly ordinary opening paragraph that runs well past the snippet cutoff. '.repeat(3);
    const stored = await ingest({
      workspaceId,
      mailboxId,
      mailboxEmail: 'outreach-warm3@emsoft.com',
      threadId: `wu-body-${runId}`,
      subject: 'Re: catching up',
      bodyText: `${filler}sequencer heartbeat ${runId}`,
    });
    expect(stored.isWarmup).toBe(false);
    expect(stored.conversation.snippet.includes('sequencer heartbeat')).toBe(false);

    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ warmupKeywords: ['sequencer heartbeat'] })
      .expect(200);
    let row = await prisma.conversation.findUniqueOrThrow({
      where: { id: stored.conversation.id },
    });
    expect(row.isWarmup).toBe(true);

    // Reverse direction still works with body-level matching.
    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ warmupKeywords: [] })
      .expect(200);
    row = await prisma.conversation.findUniqueOrThrow({ where: { id: stored.conversation.id } });
    expect(row.isWarmup).toBe(false);
  });
});
