import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  approvalTestHooks,
  overrideApproval,
  processApprovalReminders,
  resolveApprove,
} from './approval.service.js';
import { sendTestHooks } from './send.service.js';
import { emailTestHooks } from './email.service.js';

describe('Sourcing Lead approval flow (PRD 5.5)', () => {
  const app = createApp();

  async function setup(email: string) {
    const login = await request(app).post('/api/auth/login').send({ email });
    const auth = `Bearer ${login.body.token}`;
    const workspaceId = login.body.bootstrap.workspace.id as string;
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${email}`, provider: 'google' });
    const mailboxId = mailbox.body.id as string;
    const threadId = `appr-${email}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await request(app)
      .patch('/api/auth/workspace')
      .set('Authorization', auth)
      .send({ sourcingLeadEmail: 'lead@emsoft.com' })
      .expect(200);

    const conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        mailboxId,
        gmailThreadId: threadId,
        subject: 'Re: intro',
        snippet: 'sensitive question',
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
        fromName: 'Prospect',
        toJson: [{ email: `outreach-${email}`, name: null }],
        subject: 'Re: intro',
        bodyText: 'What valuation are you thinking?',
        sentAt: new Date(),
      },
    });
    // A draft is required before requesting sign-off.
    await request(app)
      .put(`/api/conversations/${conversation.id}/draft`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>Happy to discuss on a call.</p>', bodyText: 'Happy to discuss on a call.' });
    return { auth, workspaceId, conversationId: conversation.id };
  }

  it('a send past its approval precheck is still blocked once sign-off lands (TOCTOU)', async () => {
    const { auth, conversationId } = await setup('appr-race1@emsoft.com');

    // The send has read "no pending approval" and paused; a sign-off request
    // completes in the gap. The in-transaction recheck must still block it.
    sendTestHooks.afterApprovalPrecheck = async () => {
      sendTestHooks.afterApprovalPrecheck = undefined;
      await request(app)
        .post(`/api/conversations/${conversationId}/request-approval`)
        .set('Authorization', auth)
        .expect(201);
    };
    try {
      const res = await request(app)
        .post(`/api/conversations/${conversationId}/reply`)
        .set('Authorization', auth)
        .send({ bodyHtml: '<p>racing</p>', bodyText: 'racing', idempotencyKey: `race-appr-${conversationId}` });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('approval_pending');
    } finally {
      sendTestHooks.afterApprovalPrecheck = undefined;
    }
    // Nothing was persisted or dispatched.
    expect(await prisma.outboundSend.count({ where: { conversationId } })).toBe(0);
    expect(
      await prisma.message.count({ where: { conversationId, direction: 'outbound' } }),
    ).toBe(0);
    // The lock rolled back with the transaction — a later legitimate flow works.
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.sendLockedAt).toBeNull();
  });

  it('a schedule past its approval precheck is still blocked once sign-off lands (TOCTOU)', async () => {
    const { auth, conversationId } = await setup('appr-race2@emsoft.com');

    sendTestHooks.afterApprovalPrecheck = async () => {
      sendTestHooks.afterApprovalPrecheck = undefined;
      await request(app)
        .post(`/api/conversations/${conversationId}/request-approval`)
        .set('Authorization', auth)
        .expect(201);
    };
    try {
      const res = await request(app)
        .post(`/api/conversations/${conversationId}/schedule-send`)
        .set('Authorization', auth)
        .send({
          bodyHtml: '<p>racing</p>',
          bodyText: 'racing',
          scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('approval_pending');
    } finally {
      sendTestHooks.afterApprovalPrecheck = undefined;
    }
    expect(await prisma.scheduledSend.count({ where: { conversationId } })).toBe(0);
  });

  it('override cannot overwrite a Lead approval that lands concurrently', async () => {
    const { auth, workspaceId, conversationId } = await setup('appr-race4@emsoft.com');
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { conversationId } });
    // Age the request past the 24h override threshold.
    await prisma.approvalRequest.update({
      where: { id: req.id },
      data: { requestedAt: new Date(Date.now() - 25 * 3600_000) },
    });

    // The Lead's one-click approve lands between override's read and its
    // transition. The guarded updateMany must lose and leave 'approved' intact.
    approvalTestHooks.afterOverrideRead = async () => {
      approvalTestHooks.afterOverrideRead = undefined;
      await resolveApprove(req.approveToken);
    };
    try {
      await expect(overrideApproval({ workspaceId, conversationId })).rejects.toMatchObject({
        code: 'conflict',
      });
    } finally {
      approvalTestHooks.afterOverrideRead = undefined;
    }

    const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe('approved');
    expect(after.resolvedAt).not.toBeNull();
  });

  it('two simultaneous sign-off requests: one 201, one 409, exactly one pending row', async () => {
    const { auth, conversationId } = await setup('appr-race3@emsoft.com');

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/conversations/${conversationId}/request-approval`)
        .set('Authorization', auth),
      request(app)
        .post(`/api/conversations/${conversationId}/request-approval`)
        .set('Authorization', auth),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(
      await prisma.approvalRequest.count({ where: { conversationId, status: 'pending' } }),
    ).toBe(1);
  });

  it('hard-blocks Send while pending; one-click approve unblocks; links are single-use', async () => {
    const { auth, conversationId } = await setup('appr1@emsoft.com');

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);
    expect(res.body.approval.status).toBe('pending');

    // Send and schedule are hard-blocked.
    const blockedSend = await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>x</p>', bodyText: 'x', idempotencyKey: `blocked-${conversationId}` });
    expect(blockedSend.status).toBe(409);
    expect(blockedSend.body.code).toBe('approval_pending');

    const blockedSchedule = await request(app)
      .post(`/api/conversations/${conversationId}/schedule-send`)
      .set('Authorization', auth)
      .send({
        bodyHtml: '<p>x</p>',
        bodyText: 'x',
        scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      });
    expect(blockedSchedule.status).toBe(409);

    // Lead clicks Approve.
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { conversationId, status: 'pending' },
    });
    const approvePage = await request(app).get(`/api/approvals/${approval.approveToken}/approve`);
    expect(approvePage.status).toBe(200);
    expect(approvePage.text).toContain('Approved');

    // Second click: single-use.
    const again = await request(app).get(`/api/approvals/${approval.approveToken}/approve`);
    expect(again.text).toContain('already been handled');

    // Send now works.
    await request(app)
      .post(`/api/conversations/${conversationId}/reply`)
      .set('Authorization', auth)
      .send({
        bodyHtml: '<p>Happy to discuss on a call.</p>',
        bodyText: 'Happy to discuss on a call.',
        idempotencyKey: `approved-${conversationId}`,
      })
      .expect(201);
  });

  it('request-changes appends comments, flags the conversation, and allows re-request', async () => {
    const { auth, conversationId } = await setup('appr2@emsoft.com');
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);

    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { conversationId, status: 'pending' },
    });
    const submit = await request(app)
      .post(`/api/approvals/${approval.changesToken}/changes`)
      .type('form')
      .send({ comment: 'Too vague — propose a concrete time.' });
    expect(submit.status).toBe(200);

    const detail = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set('Authorization', auth);
    expect(detail.body.approval.status).toBe('changes_requested');
    expect(detail.body.approval.comments[0].commentText).toBe(
      'Too vague — propose a concrete time.',
    );
    expect(detail.body.replyStatus).toBe('needs_attention');

    // Operator revises and re-requests — a fresh pending request blocks again.
    const second = await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);
    expect(second.body.approval.status).toBe('pending');
  });

  it('keeps Lead comments from earlier rounds visible after a re-request (append-only history)', async () => {
    const { auth, conversationId } = await setup('appr4@emsoft.com');

    // Round 1: request -> changes with a comment.
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);
    let approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { conversationId, status: 'pending' },
    });
    await request(app)
      .post(`/api/approvals/${approval.changesToken}/changes`)
      .type('form')
      .send({ comment: 'Round one: too vague.' });

    // Round 2: re-request -> changes again.
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);
    approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { conversationId, status: 'pending' },
    });
    await request(app)
      .post(`/api/approvals/${approval.changesToken}/changes`)
      .type('form')
      .send({ comment: 'Round two: better, drop the last line.' });

    const detail = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set('Authorization', auth);
    const texts = detail.body.approval.comments.map(
      (c: { commentText: string | null }) => c.commentText,
    );
    expect(texts).toEqual(['Round one: too vague.', 'Round two: better, drop the last line.']);
  });

  it('change-request comments snapshot the draft the Lead actually reviewed', async () => {
    const { auth, conversationId } = await setup('appr5@emsoft.com');
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { conversationId, status: 'pending' },
    });

    // Operator edits the working draft AFTER the email went out.
    await request(app)
      .put(`/api/conversations/${conversationId}/draft`)
      .set('Authorization', auth)
      .send({ bodyHtml: '<p>Edited since.</p>', bodyText: 'Edited since.' });

    await request(app)
      .post(`/api/approvals/${approval.changesToken}/changes`)
      .type('form')
      .send({ comment: 'About the version you sent me.' });

    const comment = await prisma.approvalComment.findFirstOrThrow({
      where: { approvalRequestId: approval.id },
    });
    // The snapshot is what was EMAILED, not the later edit.
    expect(comment.draftSnapshotAtComment).toBe('Happy to discuss on a call.');
    expect(comment.draftSnapshotAtComment).not.toBe('Edited since.');
  });

  it('token resolution is single-use and atomic: a late changes click cannot override an approval', async () => {
    const { auth, conversationId } = await setup('appr6@emsoft.com');
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { conversationId, status: 'pending' },
    });

    await request(app).get(`/api/approvals/${approval.approveToken}/approve`).expect(200);

    // The changes link arrives late: it must lose the conditional transition.
    const late = await request(app)
      .post(`/api/approvals/${approval.changesToken}/changes`)
      .type('form')
      .send({ comment: 'Too late.' });
    expect(late.text).toContain('already been handled');

    const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    expect(after.status).toBe('approved');
    // Losing the transition also means no comment row was appended.
    expect(await prisma.approvalComment.count({ where: { approvalRequestId: approval.id } })).toBe(
      0,
    );
  });

  it('override only unlocks after 24 hours; reminder fires once after 4 hours', async () => {
    const { auth, workspaceId, conversationId } = await setup('appr3@emsoft.com');
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);

    // Too early for override.
    const early = await request(app)
      .post(`/api/conversations/${conversationId}/approval-override`)
      .set('Authorization', auth);
    expect(early.status).toBe(400);

    // Reminder at +5h — sets reminderSentAt exactly once.
    const inFiveHours = new Date(Date.now() + 5 * 3600_000);
    await processApprovalReminders(inFiveHours);
    let approval = await prisma.approvalRequest.findFirstOrThrow({ where: { conversationId } });
    expect(approval.reminderSentAt).not.toBeNull();
    const firstReminderAt = approval.reminderSentAt;
    await processApprovalReminders(new Date(Date.now() + 6 * 3600_000));
    approval = await prisma.approvalRequest.findFirstOrThrow({ where: { conversationId } });
    expect(approval.reminderSentAt).toEqual(firstReminderAt);

    // Override unlocks at +25h (service-level with injected clock).
    await overrideApproval({
      workspaceId,
      conversationId,
      now: new Date(Date.now() + 25 * 3600_000),
    });
    approval = await prisma.approvalRequest.findFirstOrThrow({ where: { conversationId } });
    expect(approval.status).toBe('overridden');
  });

  it('two overlapping reminder workers send the reminder only once', async () => {
    const { auth, conversationId } = await setup('appr-reminder-race@emsoft.com');
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);

    const inFiveHours = new Date(Date.now() + 5 * 3600_000);
    let dispatches = 0;
    emailTestHooks.onSend = () => {
      dispatches += 1;
    };
    approvalTestHooks.afterReminderSelection = async () => {
      approvalTestHooks.afterReminderSelection = undefined;
      await processApprovalReminders(inFiveHours);
    };
    try {
      await processApprovalReminders(inFiveHours);
    } finally {
      approvalTestHooks.afterReminderSelection = undefined;
      emailTestHooks.onSend = undefined;
    }

    expect(dispatches).toBe(1);
    const approval = await prisma.approvalRequest.findFirstOrThrow({ where: { conversationId } });
    expect(approval.reminderSentAt).not.toBeNull();
  });

  it('releases a reminder claim when the configured provider fails so the next tick retries', async () => {
    const { auth, conversationId } = await setup('appr-reminder-retry@emsoft.com');
    await request(app)
      .post(`/api/conversations/${conversationId}/request-approval`)
      .set('Authorization', auth)
      .expect(201);

    const inFiveHours = new Date(Date.now() + 5 * 3600_000);
    let dispatches = 0;
    emailTestHooks.onSend = (input) => {
      if (input.subject.startsWith('Reminder')) dispatches += 1;
    };
    emailTestHooks.deliveryOverride = {
      delivered: false,
      retryable: true,
      error: 'Email provider error: 503',
    };
    try {
      await processApprovalReminders(inFiveHours);
      let approval = await prisma.approvalRequest.findFirstOrThrow({ where: { conversationId } });
      expect(approval.reminderSentAt).toBeNull();
      expect(dispatches).toBe(1);

      delete emailTestHooks.deliveryOverride;
      await processApprovalReminders(inFiveHours);
      approval = await prisma.approvalRequest.findFirstOrThrow({ where: { conversationId } });
      expect(approval.reminderSentAt).not.toBeNull();
      expect(dispatches).toBe(2);
    } finally {
      delete emailTestHooks.onSend;
      delete emailTestHooks.deliveryOverride;
    }
  });
});
