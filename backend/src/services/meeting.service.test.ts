import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { weekBounds } from './meeting.service.js';

// Week bounds are Pacific-local Monday→Monday. A week spanning a DST change is
// not 168 elapsed hours, so the upper bound must be the next Monday's LOCAL
// midnight, not start + 7 days of milliseconds.
describe('weekBounds across Pacific DST', () => {
  it('spring-forward week ends at local Monday midnight (167 elapsed hours)', () => {
    // DST begins Sun Mar 8, 2026. Week Mon Mar 2 (PST, UTC-8) → Mon Mar 9 (PDT, UTC-7).
    const { start, end } = weekBounds(0, new Date('2026-03-04T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-03-02T08:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T07:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(167);
  });

  it('fall-back week ends at local Monday midnight (169 elapsed hours)', () => {
    // DST ends Sun Nov 1, 2026. Week Mon Oct 26 (PDT, UTC-7) → Mon Nov 2 (PST, UTC-8).
    const { start, end } = weekBounds(0, new Date('2026-10-28T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(169);
  });

  it('a non-DST week is exactly 168 hours', () => {
    const { start, end } = weekBounds(0, new Date('2026-06-17T12:00:00Z'));
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(168);
  });
});

// Live Google Calendar / Salesforce calls are exercised by the booking probe
// scripts. In the test env MEETING_BOOKING_READY and SF_READY are both false
// (all provider creds are pinned empty), so these cover the route wiring,
// request validation, and the graceful not-configured guard.
describe('meeting booking route', () => {
  async function authFor(email: string) {
    const app = createApp();
    const login = await request(app).post('/api/auth/login').send({ email });
    return {
      app,
      auth: `Bearer ${login.body.token}` as const,
      workspaceId: login.body.bootstrap.workspace.id as string,
    };
  }

  it('rejects a malformed booking payload with 400', async () => {
    const { app, auth } = await authFor(`book-bad-${Date.now()}@emsoft.com`);
    const res = await request(app)
      .post('/api/meetings/book')
      .set('Authorization', auth)
      .send({
        conversationId: 'x',
        assigneeId: 'y',
        title: 'Test',
        date: 'not-a-date',
        startMinutes: 600,
        durationMinutes: 30,
        timeZone: 'America/Los_Angeles',
      });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const app = createApp();
    const res = await request(app).post('/api/meetings/book').send({});
    expect(res.status).toBe(401);
  });

  it('404s when the conversation has no inbound reply', async () => {
    const { app, auth } = await authFor(`book-noinbound-${Date.now()}@emsoft.com`);
    const res = await request(app)
      .post('/api/meetings/book')
      .set('Authorization', auth)
      .send({
        conversationId: 'nonexistent',
        assigneeId: 'nonexistent',
        title: 'Intro & Emergence',
        date: '2026-09-15',
        startMinutes: 600,
        durationMinutes: 45,
        timeZone: 'America/Los_Angeles',
      });
    expect(res.status).toBe(404);
  });

  it('reports not-configured (400) once a bookable conversation resolves', async () => {
    const { app, auth, workspaceId } = await authFor(`book-ready-${Date.now()}@emsoft.com`);
    const mailbox = await request(app)
      .post('/api/mailboxes/connect/mock')
      .set('Authorization', auth)
      .send({ email: `outreach-${Date.now()}@emsoft.com`, provider: 'google' });
    const mailboxId = mailbox.body.id as string;

    const threadId = `book-thread-${Date.now()}`;
    const conversation = await prisma.conversation.create({
      data: {
        workspaceId,
        mailboxId,
        gmailThreadId: threadId,
        subject: 'Re: intro',
        snippet: 'sounds good',
        lastMessageAt: new Date(),
        messageCount: 1,
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        mailboxId,
        gmailMessageId: `book-msg-${threadId}`,
        gmailThreadId: threadId,
        direction: 'inbound',
        fromEmail: 'prospect@example.com',
        fromName: 'Prospect',
        toJson: [{ email: mailbox.body.email, name: null }],
        subject: 'Re: intro',
        bodyText: 'sounds good',
        sentAt: new Date(),
      },
    });
    const assignee = await prisma.meetingAssignee.create({
      data: { workspaceId, name: 'Akash L', email: 'akash@emergence.com', tag: 'recommended' },
    });

    const res = await request(app)
      .post('/api/meetings/book')
      .set('Authorization', auth)
      .send({
        conversationId: conversation.id,
        assigneeId: assignee.id,
        title: 'Prospect & Emergence',
        date: '2026-09-15',
        startMinutes: 600,
        durationMinutes: 45,
        timeZone: 'America/Los_Angeles',
      });
    // Calendar credentials are absent in the test env, so booking is rejected
    // before any provider call — the guard, not a live failure.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not configured/i);
  });
});
