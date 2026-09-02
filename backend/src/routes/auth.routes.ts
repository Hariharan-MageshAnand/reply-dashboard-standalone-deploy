import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { upsertUserAndWorkspace, writeAudit } from '../services/auth.service.js';
import {
  issueLocalSession,
  resolveLocalIdentity,
} from '../services/local-identity.service.js';
import { requireAuth } from '../types/auth.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().min(1).max(80).optional(),
      })
      .parse(req.body);

    const { token, identity } = issueLocalSession({
      email: body.email,
      name: body.name,
    });
    const bootstrap = await upsertUserAndWorkspace(identity);
    res.json({ token, bootstrap });
  }),
);

authRouter.post(
  '/bootstrap',
  asyncHandler(async (req, res) => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({
        code: 'unauthorized',
        message: 'Sign in required.',
      });
      return;
    }
    const identity = resolveLocalIdentity(token);
    const bootstrap = await upsertUserAndWorkspace(identity);
    res.json(bootstrap);
  }),
);

authRouter.get(
  '/me',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const header = req.header('authorization')!;
    const token = header.slice(7).trim();
    const identity = resolveLocalIdentity(token);
    const bootstrap = await upsertUserAndWorkspace(identity);
    res.json(bootstrap);
  }),
);

authRouter.patch(
  '/workspace',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const body = z
      .object({
        name: z.string().min(2).max(80).optional(),
        warmupKeywords: z.array(z.string().min(1).max(100)).max(100).optional(),
        slaMinutes: z.number().int().min(5).max(1440).optional(),
        sourcingLeadEmail: z.string().email().nullable().optional(),
      })
      .parse(req.body);
    const { prisma } = await import('../lib/prisma.js');

    if (body.name) {
      await prisma.workspace.update({
        where: { id: auth.workspaceId },
        data: { name: body.name },
      });
      await writeAudit({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: 'workspace.renamed',
        entityType: 'workspace',
        entityId: auth.workspaceId,
        metadata: { name: body.name },
      });
    }

    if (body.warmupKeywords) {
      const { updateWarmupKeywords } = await import('../services/warmup.service.js');
      const result = await updateWarmupKeywords(auth.workspaceId, body.warmupKeywords);
      await writeAudit({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: 'workspace.warmup_keywords_updated',
        entityType: 'workspace',
        entityId: auth.workspaceId,
        metadata: result,
      });
    }

    if (body.slaMinutes !== undefined) {
      await prisma.workspace.update({
        where: { id: auth.workspaceId },
        data: { slaMinutes: body.slaMinutes },
      });
      await writeAudit({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: 'workspace.sla_updated',
        entityType: 'workspace',
        entityId: auth.workspaceId,
        metadata: { slaMinutes: body.slaMinutes },
      });
    }

    if (body.sourcingLeadEmail !== undefined) {
      await prisma.workspace.update({
        where: { id: auth.workspaceId },
        data: { sourcingLeadEmail: body.sourcingLeadEmail },
      });
      await writeAudit({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        action: 'workspace.sourcing_lead_updated',
        entityType: 'workspace',
        entityId: auth.workspaceId,
        metadata: { sourcingLeadEmail: body.sourcingLeadEmail },
      });
    }

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: auth.workspaceId },
    });
    res.json({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: auth.workspaceRole,
      warmupKeywords: workspace.warmupKeywords,
      slaMinutes: workspace.slaMinutes,
      sourcingLeadEmail: workspace.sourcingLeadEmail,
    });
  }),
);
