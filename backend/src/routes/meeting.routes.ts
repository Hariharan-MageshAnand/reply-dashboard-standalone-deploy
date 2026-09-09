import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { param } from '../lib/params.js';
import { env } from '../config/env.js';
import {
  addAssignee,
  bookMeeting,
  getAssigneeWeekEvents,
  getAssignmentDesk,
  seedDefaultAssignees,
  updateAssigneeLimit,
} from '../services/meeting.service.js';
import { requireAuth } from '../types/auth.js';

export const meetingRouter = Router();
meetingRouter.use(authMiddleware);

/** Assignment desk: the roster with live weekly meeting counts vs limits. */
meetingRouter.get(
  '/desk',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    if (!env.CALENDAR_READY) {
      res.json({ ready: false, weekLabel: '', weekStart: null, assignees: [] });
      return;
    }
    const week = z.coerce.number().int().min(-8).max(8).default(0).parse(req.query.week ?? 0);
    await seedDefaultAssignees(auth.workspaceId);
    const desk = await getAssignmentDesk(auth.workspaceId, week);
    res.json({ ready: true, ...desk });
  }),
);

/** Calendar step: the selected member's events for the chosen week. */
meetingRouter.get(
  '/calendar/:assigneeId',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const week = z.coerce.number().int().min(-8).max(8).default(0).parse(req.query.week ?? 0);
    const data = await getAssigneeWeekEvents(auth.workspaceId, param(req, 'assigneeId'), week);
    res.json(data);
  }),
);

meetingRouter.post(
  '/assignees',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        name: z.string().min(1).max(80),
        email: z.string().email(),
        tag: z.enum(['recommended', 'alternative', 'not_recommended']).optional(),
      })
      .parse(req.body);
    const assignee = await addAssignee(auth.workspaceId, body);
    res.status(201).json(assignee);
  }),
);

meetingRouter.patch(
  '/assignees/:assigneeId/limit',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z.object({ weeklyMeetingLimit: z.number().int().min(0).max(500) }).parse(req.body);
    await updateAssigneeLimit(auth.workspaceId, param(req, 'assigneeId'), body.weeklyMeetingLimit);
    res.json({ ok: true });
  }),
);

/**
 * Book a meeting in-app: creates the Google Calendar event (Meet link + guests)
 * on meeting@emergence.com's calendar and, when the prospect maps to a
 * Salesforce account, creates an Opportunity — the webapp's "Schedule Meeting".
 */
meetingRouter.post(
  '/book',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        conversationId: z.string().min(1),
        assigneeId: z.string().min(1),
        title: z.string().min(1).max(300),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startMinutes: z.number().int().min(0).max(24 * 60 - 1),
        durationMinutes: z.number().int().min(5).max(24 * 60),
        timeZone: z.string().min(1).max(64),
      })
      .parse(req.body);
    const result = await bookMeeting(auth.workspaceId, body);
    res.status(201).json(result);
  }),
);
