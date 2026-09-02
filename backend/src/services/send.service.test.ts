import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  classifySendError,
  markReconciledFailed,
  processDueScheduledSends,
  scheduledSendTestHooks,
  sendTestHooks,
} from './send.service.js';
import { upsertConversationMessage } from './message-store.service.js';
import { resurfaceDueSnoozed } from './conversation.service.js';
import { AppError } from '../lib/errors.js';

describe('classifySendError', () => {
  it('treats provider HTTP responses as definitive', () => {
    expect(classifySendError(new AppError('provider_error', 'Graph said no', 502)).kind).toBe(
      'definitive',
    );
    const gaxiosLike = Object.assign(new Error('Bad Request'), { response: { status: 400 } });
    expect(classifySendError(gaxiosLike).kind).toBe('definitive');
  });

  it('treats pre-connection failures as definitive (nothing was sent)', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifySendError(refused).kind).toBe('definitive');
    const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(classifySendError(dns).kind).toBe('definitive');
  });

  it('treats timeouts and unknown errors as ambiguous — never risk a double send', () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'SendTimeoutError' });
    expect(classifySendError(timeout).kind).toBe('ambiguous');
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifySendError(reset).kind).toBe('ambiguous');
    expect(classifySendError(new Error('mystery')).kind).toBe('ambiguous');
  });
});

describe('reply send state machine + snooze (mock mode)', () => {
  const app = createApp();

  // Mock mode seeds nothing — each test creates its own conversation fixture.
  // Unique suffix per run: the dev DB persists across test runs.
  async function setup(email: string) {
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    expect(mailbox.status).toBe(201);
    const mailboxId = mailbox.body.id as string;

    const threadId = `thread-${email}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        mailboxId,
        gmailThreadId: threadId,
        subject: 'Re: intro',
        snippet: 'Interested — tell me more',
        unread: true,
        status: 'open',
        replyStatus: 'awaiting_reply',
        lastMessageAt: new Date(),
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
        fromName: 'Test Prospect',
        toJson: [{ email: `outreach-${email}`, name: null }],
        subject: 'Re: intro',
        bodyText: 'Interested — tell me more',
        sentAt: new Date(),
      },
    });
    return {
      auth,
      conversationId: conversation.id,
      workspaceId,
      mailboxId,
      mailboxEmail: `outreach-${email}`,
      threadId,
    };
  }

  it('sends exactly once for a given idempotency key', async () => {
    const { auth, conversationId } = await setup('sender@emsoft.com');
    const key = `test-key-${conversationId}`;

    const first = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>hello</p>', bodyText: 'hello', idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(first.body.sendState.status).toBe('sent');

    const outboundAfterFirst = await prisma.message.count({
      where: { conversationId, direction: 'outbound' },
    });

    const replay = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>hello</p>', bodyText: 'hello', idempotencyKey: key });
    expect(replay.status).toBe(201);

    const outboundAfterReplay = await prisma.message.count({
      where: { conversationId, direction: 'outbound' },
    });
    expect(outboundAfterReplay).toBe(outboundAfterFirst);

    const attempts = await prisma.outboundSend.count({ where: { conversationId } });
    expect(attempts).toBe(1);
  });

  it('releases the send lock after a completed send so a later reply is possible', async () => {
    const { auth, conversationId } = await setup('sender2@emsoft.com');

    const first = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>one</p>', bodyText: 'one', idempotencyKey: `k1-${conversationId}` });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>two</p>', bodyText: 'two', idempotencyKey: `k2-${conversationId}` });
    expect(second.status).toBe(201);

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.sendLockedAt).toBeNull();
  });

  afterEach(() => {
    delete sendTestHooks.afterLockInTx;
    delete sendTestHooks.afterAttemptPersisted;
  });

  it('two overlapping sends: the paused lock holder wins, the second cannot send or clear the lock', async () => {
    const { auth, conversationId } = await setup('race1@emsoft.com');

    // Pause sender A twice: inside the acquire transaction (after the lock is
    // claimed, before the attempt commits — the exact gap the old
    // lock-then-create sequence exposed), and again while its attempt is
    // in-flight. Hooks are consume-once so only the first sender (A) pauses;
    // B can never reach them while A holds the lock anyway.
    const pauseOnce = (ms: number) => {
      let used = false;
      return () => {
        if (used) return Promise.resolve();
        used = true;
        return new Promise<void>((resolve) => setTimeout(resolve, ms));
      };
    };
    sendTestHooks.afterLockInTx = pauseOnce(150);
    sendTestHooks.afterAttemptPersisted = pauseOnce(500);

    const sendA = request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>A</p>', bodyText: 'A', idempotencyKey: `race-a-${conversationId}` });
    // B starts while A is paused mid-transaction.
    const sendB = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return request(app)
        .post(`/api/conversations/${conversationId}/reply`)
        .set('Authorization', auth)
        .send({ bodyHtml: '<p>B</p>', bodyText: 'B', idempotencyKey: `race-b-${conversationId}` });
    })();

    const [resA, resB] = await Promise.all([sendA, sendB]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Exactly one provider send, one attempt — B neither sent nor cleared A's lock.
    const outbound = await prisma.message.count({
      where: { conversationId, direction: 'outbound' },
    });
    expect(outbound).toBe(1);
    const attempts = await prisma.outboundSend.findMany({ where: { conversationId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('sent');
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.sendLockedAt).toBeNull();
  });

  it('self-heals a genuinely stale lock (crash leftovers) without blocking forever', async () => {
    const { auth, conversationId } = await setup('stale1@emsoft.com');
    // Crash state: lock held, but no live attempt (terminal update landed,
    // release never ran).
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { sendLockedAt: new Date(Date.now() - 60_000) },
    });

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>x</p>', bodyText: 'x', idempotencyKey: `stale-${conversationId}` });
    expect(res.status).toBe(201);
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.sendLockedAt).toBeNull();
  });

  it('blocks a concurrent send while an attempt is pending', async () => {
    const { auth, conversationId } = await setup('sender3@emsoft.com');
    // Simulate an unresolved (ambiguous) attempt: lock held + attempt 'sending'.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { sendLockedAt: new Date() },
    });
    await prisma.outboundSend.create({
      data: {
        conversationId,
        authorId: 'op',
        idempotencyKey: `pending-${conversationId}`,
        status: 'sending',
        bodyHtml: '<p>x</p>',
        bodyText: 'x',
      },
    });

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>y</p>', bodyText: 'y', idempotencyKey: `other-${conversationId}` });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');

    const detail = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set('Authorization', auth);
    expect(detail.body.sendState.status).toBe('sending');
  });

  it('reconciliation terminalizes and releases atomically — no window for a racing sender', async () => {
    const { auth, conversationId, workspaceId } = await setup('reconcile1@emsoft.com');
    const author = await prisma.user.findFirstOrThrow({
      where: { memberships: { some: { workspaceId } } },
    });

    // An ambiguous send left behind: attempt stuck in 'sending', lock held.
    const lockStamp = new Date();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { sendLockedAt: lockStamp },
    });
    const attempt = await prisma.outboundSend.create({
      data: {
        conversationId,
        authorId: author.id,
        idempotencyKey: `ambiguous-${conversationId}`,
        status: 'sending',
        bodyHtml: '<p>held</p>',
        bodyText: 'held',
      },
    });

    // Pause reconciliation between terminalizing the attempt and releasing the
    // lock — the exact window the old sequential code exposed. A new sender
    // arriving now must see the still-'sending' committed state and conflict,
    // NOT self-heal and acquire (which the delayed release would then clear).
    let racedStatus = 0;
    sendTestHooks.betweenReconcileTerminalizeAndRelease = async () => {
      sendTestHooks.betweenReconcileTerminalizeAndRelease = undefined;
      const raced = await request(app)
        .post(`/api/conversations/${conversationId}/reply`)
        .set('Authorization', auth)
        .send({ bodyHtml: '<p>new</p>', bodyText: 'new', idempotencyKey: `raced-${conversationId}` });
      racedStatus = raced.status;
    };
    try {
      await markReconciledFailed({ id: attempt.id, conversationId });
    } finally {
      sendTestHooks.betweenReconcileTerminalizeAndRelease = undefined;
    }
    expect(racedStatus).toBe(409);

    // After the atomic commit: attempt failed, lock cleanly released…
    const resolved = await prisma.outboundSend.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(resolved.status).toBe('failed');
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.sendLockedAt).toBeNull();

    // …and a fresh send acquires and completes normally.
    const after = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>after</p>', bodyText: 'after', idempotencyKey: `after-${conversationId}` });
    expect(after.status).toBe(201);
  });

  it('two concurrent schedule requests create exactly one queued row and one send', async () => {
    const { auth, conversationId } = await setup('sched-conc@emsoft.com');
    const at = new Date(Date.now() + 3600_000);
    const body = { bodyHtml: '<p>once</p>', bodyText: 'once', scheduledFor: at.toISOString() };

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/conversations/${conversationId}/schedule-send`)
        .set('Authorization', auth)
        .send(body),
      request(app)
        .post(`/api/conversations/${conversationId}/schedule-send`)
        .set('Authorization', auth)
        .send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(
      await prisma.scheduledSend.count({ where: { conversationId, status: 'scheduled' } }),
    ).toBe(1);

    // When due, exactly one message goes out.
    const fired = await processDueScheduledSends(new Date(at.getTime() + 1000));
    expect(fired).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.message.count({ where: { conversationId, direction: 'outbound' } }),
    ).toBe(1);
  });

  it('rejects a second schedule while a claimed row is still processing', async () => {
    const { auth, conversationId } = await setup('sched-processing@emsoft.com');
    const at = new Date(Date.now() + 1000);
    await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>first</p>', bodyText: 'first', scheduledFor: at.toISOString() })
      .expect(201);

    let secondStatus = 0;
    let cancelStatus = 0;
    scheduledSendTestHooks.afterClaim = async () => {
      scheduledSendTestHooks.afterClaim = undefined;
      const second = await request(app)
        .post(`/api/conversations/${conversationId}/schedule-send`)
        .set('Authorization', auth)
        .send({
          bodyHtml: '<p>second</p>',
          bodyText: 'second',
          scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
        });
      secondStatus = second.status;
      const cancel = await request(app)
        .delete(`/api/conversations/${conversationId}/schedule-send`)
        .set('Authorization', auth);
      cancelStatus = cancel.status;
    };
    try {
      const fired = await processDueScheduledSends(new Date(at.getTime() + 1000));
      expect(fired).toBe(1);
    } finally {
      scheduledSendTestHooks.afterClaim = undefined;
    }

    expect(secondStatus).toBe(409);
    expect(cancelStatus).toBe(409);
    expect(await prisma.scheduledSend.count({ where: { conversationId } })).toBe(1);
    const row = await prisma.scheduledSend.findFirstOrThrow({ where: { conversationId } });
    expect(row.status).toBe('sent');
    expect(
      await prisma.message.count({ where: { conversationId, direction: 'outbound' } }),
    ).toBe(1);
  });

  it('a manual reply cancels a pending scheduled send so only one outbound goes out', async () => {
    const { auth, conversationId } = await setup('sched-vs-manual@emsoft.com');
    const at = new Date(Date.now() + 3600_000);
    await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>queued</p>', bodyText: 'queued', scheduledFor: at.toISOString() })
      .expect(201);

    const sent = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({
        bodyHtml: '<p>sending now</p>',
        bodyText: 'sending now',
        idempotencyKey: `manual-${conversationId}`,
      });
    expect(sent.status).toBe(201);

    const fired = await processDueScheduledSends(new Date(at.getTime() + 1000));
    expect(fired).toBe(0);

    const row = await prisma.scheduledSend.findFirstOrThrow({ where: { conversationId } });
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('superseded_by_manual_send');
    const outbound = await prisma.message.findMany({
      where: { conversationId, direction: 'outbound' },
    });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].bodyText).toBe('sending now');
  });

  it('schedules a send, holds until due, then fires through the state machine', async () => {
    const { auth, conversationId } = await setup('sched1@emsoft.com');
    const at = new Date(Date.now() + 3600_000);

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>later</p>', bodyText: 'later', scheduledFor: at.toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.scheduledSend.status).toBe('scheduled');
    expect(res.body.scheduledFor).toBe(at.toISOString());

    // A second schedule while one is pending is rejected.
    const dup = await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>x</p>', bodyText: 'x', scheduledFor: at.toISOString() });
    expect(dup.status).toBe(409);

    await processDueScheduledSends(new Date());
    let row = await prisma.scheduledSend.findFirstOrThrow({ where: { conversationId } });
    expect(row.status).toBe('scheduled');

    await processDueScheduledSends(new Date(at.getTime() + 1000));
    row = await prisma.scheduledSend.findFirstOrThrow({ where: { conversationId } });
    expect(row.status).toBe('sent');
    const outbound = await prisma.message.count({
      where: { conversationId, direction: 'outbound' },
    });
    expect(outbound).toBe(1);
  });

  it('auto-cancels a pending scheduled send when the contact replies again', async () => {
    const { auth, conversationId, workspaceId, mailboxId, mailboxEmail, threadId } =
      await setup('sched2@emsoft.com');
    const at = new Date(Date.now() + 3600_000);
    await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>queued</p>', bodyText: 'queued', scheduledFor: at.toISOString() });

    await upsertConversationMessage({
      workspaceId,
      mailboxId,
      mailboxEmail,
      gmailThreadId: threadId,
      gmailMessageId: `msg2-${conversationId}`,
      direction: 'inbound',
      subject: 'Re: intro',
      snippet: 'Actually, one more question',
      bodyHtml: null,
      bodyText: 'Actually, one more question',
      fromEmail: 'prospect@example.com',
      fromName: 'Test Prospect',
      to: [{ email: mailboxEmail, name: null, role: 'to' }],
      cc: [],
      sentAt: new Date(),
      unread: true,
    });

    const row = await prisma.scheduledSend.findFirstOrThrow({ where: { conversationId } });
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('auto_cancelled_new_reply');
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.replyStatus).toBe('needs_attention');
    expect(conversation.unread).toBe(true);
    // The queued content comes back as a draft for review — never lost.
    const draft = await prisma.replyDraft.findUnique({ where: { conversationId } });
    expect(draft?.bodyText).toBe('queued');
  });

  it('does not fire a due send that an inbound reply cancelled after due-row selection', async () => {
    const { auth, conversationId, workspaceId, mailboxId, mailboxEmail, threadId } =
      await setup('sched-race@emsoft.com');
    const at = new Date(Date.now() + 1000);
    await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>stale</p>', bodyText: 'stale', scheduledFor: at.toISOString() });

    // Interleave the reviewer's race: the processor has read the due row, then
    // an inbound reply lands (auto-cancelling it) before the row is claimed.
    scheduledSendTestHooks.afterDueSelection = async () => {
      scheduledSendTestHooks.afterDueSelection = undefined;
      await upsertConversationMessage({
        workspaceId,
        mailboxId,
        mailboxEmail,
        gmailThreadId: threadId,
        gmailMessageId: `race-inbound-${conversationId}`,
        direction: 'inbound',
        subject: 'Re: intro',
        snippet: 'Wait — new information',
        bodyHtml: null,
        bodyText: 'Wait — new information',
        fromEmail: 'prospect@example.com',
        fromName: 'Test Prospect',
        to: [{ email: mailboxEmail, name: null, role: 'to' }],
        cc: [],
        sentAt: new Date(),
        unread: true,
      });
    };
    try {
      const fired = await processDueScheduledSends(new Date(at.getTime() + 1000));
      expect(fired).toBe(0);
    } finally {
      scheduledSendTestHooks.afterDueSelection = undefined;
    }

    // The claim lost against the cancel, so nothing went out.
    const row = await prisma.scheduledSend.findFirstOrThrow({ where: { conversationId } });
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('auto_cancelled_new_reply');
    const outbound = await prisma.message.count({
      where: { conversationId, direction: 'outbound' },
    });
    expect(outbound).toBe(0);
    expect(await prisma.outboundSend.count({ where: { conversationId } })).toBe(0);
    // The queued content survived as a draft.
    const draft = await prisma.replyDraft.findUnique({ where: { conversationId } });
    expect(draft?.bodyText).toBe('stale');
  });

  it('inbound arriving after the send fired cannot cancel the sent row', async () => {
    const { auth, conversationId, workspaceId, mailboxId, mailboxEmail, threadId } =
      await setup('sched-race2@emsoft.com');
    const at = new Date(Date.now() + 1000);
    await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>going out</p>', bodyText: 'going out', scheduledFor: at.toISOString() });

    const fired = await processDueScheduledSends(new Date(at.getTime() + 1000));
    expect(fired).toBe(1);

    await upsertConversationMessage({
      workspaceId,
      mailboxId,
      mailboxEmail,
      gmailThreadId: threadId,
      gmailMessageId: `late-inbound-${conversationId}`,
      direction: 'inbound',
      subject: 'Re: intro',
      snippet: 'Following up',
      bodyHtml: null,
      bodyText: 'Following up',
      fromEmail: 'prospect@example.com',
      fromName: 'Test Prospect',
      to: [{ email: mailboxEmail, name: null, role: 'to' }],
      cc: [],
      sentAt: new Date(),
      unread: true,
    });

    // The status-guarded cancel must not rewrite history or resurrect a draft
    // for a message that was already delivered.
    const row = await prisma.scheduledSend.findFirstOrThrow({ where: { conversationId } });
    expect(row.status).toBe('sent');
    expect(row.cancelReason).toBeNull();
    expect(await prisma.replyDraft.findUnique({ where: { conversationId } })).toBeNull();
  });

  it('operator cancel restores the scheduled content as a draft', async () => {
    const { auth, conversationId } = await setup('sched3@emsoft.com');
    const at = new Date(Date.now() + 3600_000);
    await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>hold this</p>', bodyText: 'hold this', scheduledFor: at.toISOString() });

    const res = await request(app)
      .delete(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.scheduledSend.status).toBe('cancelled');
    expect(res.body.scheduledSend.cancelReason).toBe('cancelled_by_operator');
    expect(res.body.draft?.bodyText).toBe('hold this');
  });

  it('snoozes with a future date, rejects past/missing dates, and resurfaces when due', async () => {
    const { auth, conversationId } = await setup('sender4@emsoft.com');

    const missing = await request(app)
      .patch(`/api/conversations/${conversationId}/status`)
      .set('Authorization', auth)
      .send({ status: 'snoozed' });
    expect(missing.status).toBe(400);

    const past = await request(app)
      .patch(`/api/conversations/${conversationId}/status`)
      .set('Authorization', auth)
      .send({ status: 'snoozed', snoozedUntil: new Date(Date.now() - 60_000).toISOString() });
    expect(past.status).toBe(400);

    const until = new Date(Date.now() + 3600_000);
    const ok = await request(app)
      .patch(`/api/conversations/${conversationId}/status`)
      .set('Authorization', auth)
      .send({ status: 'snoozed', snoozedUntil: until.toISOString() });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('snoozed');
    expect(ok.body.snoozedUntil).toBe(until.toISOString());

    // Not due yet: nothing resurfaces.
    await resurfaceDueSnoozed(new Date());
    let row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.status).toBe('snoozed');

    // Past the snooze date: back to open and unread.
    await resurfaceDueSnoozed(new Date(until.getTime() + 1000));
    row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.status).toBe('open');
    expect(row.snoozedUntil).toBeNull();
    expect(row.unread).toBe(true);
  });
});
