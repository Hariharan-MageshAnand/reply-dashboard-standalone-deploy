import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '../lib/errors.js';
import { param } from '../lib/params.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  assignConversation,
  getConversation,
  listConversations,
  markConversationRead,
  saveDraft,
  setConversationLabels,
  updateConversationStatus,
} from '../services/conversation.service.js';
import {
  cancelScheduledReply,
  scheduleReply,
  sendConversationReply,
} from '../services/send.service.js';
import {
  classifyInboundMessage,
  correctConversationLabel,
  generateConversationDraft,
} from '../services/ai.service.js';
import { overrideApproval, requestApproval } from '../services/approval.service.js';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../services/auth.service.js';
import { requireAuth } from '../types/auth.js';

export const conversationRouter = Router();
conversationRouter.use(authMiddleware);

conversationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const query = z
      .object({
        mailboxId: z.string().optional(),
        unread: z
          .enum(['true', 'false'])
          .optional()
          .transform((v) => (v === undefined ? undefined : v === 'true')),
        status: z.enum(['open', 'snoozed', 'archived', 'closed']).optional(),
        replyStatus: z.enum(['awaiting_reply', 'replied', 'needs_attention', 'none']).optional(),
        replyLabel: z
          .enum([
            'interested',
            'interested_more_info',
            'not_interested',
            'ooo',
            'wrong_person',
            'unsubscribe',
            'auto_reply',
            'needs_review',
          ])
          .optional(),
        label: z.string().optional(),
        assigneeId: z.string().optional(),
        q: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().min(1).max(100).optional(),
        warmup: z
          .enum(['true', 'false'])
          .optional()
          .transform((v) => (v === undefined ? undefined : v === 'true')),
      })
      .parse(req.query);

    const result = await listConversations(auth.workspaceId, query);
    res.json(result);
  }),
);

conversationRouter.get(
  '/:conversationId',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const detail = await getConversation(auth.workspaceId, param(req, 'conversationId'));
    res.json(detail);
  }),
);

conversationRouter.post(
  '/:conversationId/read',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z.object({ unread: z.boolean() }).parse(req.body);
    const detail = await markConversationRead(
      auth.workspaceId,
      param(req, 'conversationId'),
      body.unread,
    );
    res.json(detail);
  }),
);

conversationRouter.patch(
  '/:conversationId/status',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        status: z.enum(['open', 'snoozed', 'archived', 'closed']),
        snoozedUntil: z.iso.datetime().optional(),
      })
      .parse(req.body);
    if (body.status === 'snoozed') {
      if (!body.snoozedUntil) {
        throw new AppError('validation_error', 'A snooze date is required.', 400, {
          snoozedUntil: 'Pick when this conversation should come back.',
        });
      }
      if (new Date(body.snoozedUntil).getTime() <= Date.now()) {
        throw new AppError('validation_error', 'Snooze date must be in the future.', 400, {
          snoozedUntil: 'Pick a future date and time.',
        });
      }
    }
    const conversationId = param(req, 'conversationId');
    const detail = await updateConversationStatus(
      auth.workspaceId,
      conversationId,
      body.status,
      body.status === 'snoozed' ? new Date(body.snoozedUntil!) : null,
    );
    await writeAudit({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: 'conversation.status',
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { status: body.status, snoozedUntil: body.snoozedUntil ?? null },
    });
    res.json(detail);
  }),
);

conversationRouter.patch(
  '/:conversationId/assign',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z.object({ assigneeId: z.string().nullable() }).parse(req.body);
    const conversationId = param(req, 'conversationId');
    const detail = await assignConversation(
      auth.workspaceId,
      conversationId,
      body.assigneeId,
    );
    await writeAudit({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: 'conversation.assign',
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { assigneeId: body.assigneeId },
    });
    res.json(detail);
  }),
);

conversationRouter.put(
  '/:conversationId/labels',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z.object({ labels: z.array(z.string().min(1).max(40)).max(20) }).parse(req.body);
    const detail = await setConversationLabels(
      auth.workspaceId,
      param(req, 'conversationId'),
      body.labels,
    );
    res.json(detail);
  }),
);

conversationRouter.put(
  '/:conversationId/draft',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        bodyHtml: z.string(),
        bodyText: z.string(),
      })
      .parse(req.body);
    const draft = await saveDraft(
      auth.workspaceId,
      param(req, 'conversationId'),
      auth.userId,
      body.bodyHtml,
      body.bodyText,
    );
    res.json(draft);
  }),
);

conversationRouter.post(
  '/:conversationId/reply',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        bodyHtml: z.string().min(1),
        bodyText: z.string().min(1),
        idempotencyKey: z.string().min(8).max(100),
      })
      .parse(req.body);
    const conversationId = param(req, 'conversationId');

    const result = await sendConversationReply({
      workspaceId: auth.workspaceId,
      conversationId,
      authorId: auth.userId,
      bodyHtml: body.bodyHtml,
      bodyText: body.bodyText,
      idempotencyKey: body.idempotencyKey,
    });

    if (!result.replayed) {
      await writeAudit({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: result.outcome === 'sent' ? 'conversation.reply' : 'conversation.reply_pending',
        entityType: 'conversation',
        entityId: conversationId,
      });
    }

    const detail = await getConversation(auth.workspaceId, conversationId);
    // 202 signals an unresolved send: the client must keep Send disabled and
    // poll until reconciliation lands on sent or failed.
    res.status(result.outcome === 'sent' ? 201 : 202).json(detail);
  }),
);

conversationRouter.post(
  '/:conversationId/schedule-send',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        bodyHtml: z.string().min(1),
        bodyText: z.string().min(1),
        scheduledFor: z.iso.datetime(),
      })
      .parse(req.body);
    const conversationId = param(req, 'conversationId');

    await scheduleReply({
      workspaceId: auth.workspaceId,
      conversationId,
      authorId: auth.userId,
      bodyHtml: body.bodyHtml,
      bodyText: body.bodyText,
      scheduledFor: new Date(body.scheduledFor),
    });
    await writeAudit({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: 'conversation.schedule_send',
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { scheduledFor: body.scheduledFor },
    });
    const detail = await getConversation(auth.workspaceId, conversationId);
    res.status(201).json(detail);
  }),
);

conversationRouter.post(
  '/:conversationId/classify',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const conversationId = param(req, 'conversationId');
    // Canonical newest-inbound ordering — must match classifyInboundMessage
    // and getConversation exactly, or an equal-sentAt tie makes this classify
    // a different message than the one the rest of the system treats as newest.
    const latestInbound = await prisma.message.findFirst({
      where: { conversationId, direction: 'inbound', conversation: { workspaceId: auth.workspaceId } },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    });
    if (!latestInbound) {
      throw new AppError('not_found', 'No inbound reply to classify.', 404);
    }
    await classifyInboundMessage(latestInbound.id);
    const detail = await getConversation(auth.workspaceId, conversationId);
    res.json(detail);
  }),
);

conversationRouter.post(
  '/:conversationId/label',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        label: z.enum([
          'interested',
          'interested_more_info',
          'not_interested',
          'ooo',
          'wrong_person',
          'unsubscribe',
          'auto_reply',
          'needs_review',
        ]),
      })
      .parse(req.body);
    const conversationId = param(req, 'conversationId');
    await correctConversationLabel(auth.workspaceId, conversationId, body.label, auth.userId);
    await writeAudit({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: 'conversation.label_corrected',
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { label: body.label },
    });
    const detail = await getConversation(auth.workspaceId, conversationId);
    res.json(detail);
  }),
);

conversationRouter.post(
  '/:conversationId/generate-draft',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z.object({ instruction: z.string().max(500).optional() }).parse(req.body ?? {});
    const conversationId = param(req, 'conversationId');
    await generateConversationDraft({
      workspaceId: auth.workspaceId,
      conversationId,
      authorId: auth.userId,
      instruction: body.instruction,
    });
    const detail = await getConversation(auth.workspaceId, conversationId);
    res.status(201).json(detail);
  }),
);

conversationRouter.post(
  '/:conversationId/request-approval',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const conversationId = param(req, 'conversationId');
    await requestApproval({
      workspaceId: auth.workspaceId,
      conversationId,
      requestedById: auth.userId,
    });
    await writeAudit({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: 'conversation.approval_requested',
      entityType: 'conversation',
      entityId: conversationId,
    });
    const detail = await getConversation(auth.workspaceId, conversationId);
    res.status(201).json(detail);
  }),
);

conversationRouter.post(
  '/:conversationId/approval-override',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const conversationId = param(req, 'conversationId');
    await overrideApproval({ workspaceId: auth.workspaceId, conversationId });
    await writeAudit({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: 'conversation.approval_overridden',
      entityType: 'conversation',
      entityId: conversationId,
    });
    const detail = await getConversation(auth.workspaceId, conversationId);
    res.json(detail);
  }),
);

conversationRouter.delete(
  '/:conversationId/schedule-send',
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const conversationId = param(req, 'conversationId');
    await cancelScheduledReply(auth.workspaceId, conversationId);
    await writeAudit({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      action: 'conversation.schedule_send_cancelled',
      entityType: 'conversation',
      entityId: conversationId,
    });
    const detail = await getConversation(auth.workspaceId, conversationId);
    res.json(detail);
  }),
);
