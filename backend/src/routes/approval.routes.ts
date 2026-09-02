import { Router, urlencoded } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import {
  changesForm,
  resolveApprove,
  submitChanges,
} from '../services/approval.service.js';

/**
 * Public, token-authenticated one-click endpoints for the Sourcing Lead. The
 * Lead never logs in (PRD 5.5) — tokens are single-use and unguessable.
 */
export const approvalRouter = Router();
approvalRouter.use(urlencoded({ extended: false }));

approvalRouter.get(
  '/:token/approve',
  asyncHandler(async (req, res) => {
    const html = await resolveApprove(req.params.token as string);
    res.type('html').send(html);
  }),
);

approvalRouter.get(
  '/:token/changes',
  asyncHandler(async (req, res) => {
    const html = await changesForm(req.params.token as string);
    res.type('html').send(html);
  }),
);

approvalRouter.post(
  '/:token/changes',
  asyncHandler(async (req, res) => {
    const body = z.object({ comment: z.string().max(2000).optional().default('') }).parse(req.body);
    const html = await submitChanges(req.params.token as string, body.comment);
    res.type('html').send(html);
  }),
);
