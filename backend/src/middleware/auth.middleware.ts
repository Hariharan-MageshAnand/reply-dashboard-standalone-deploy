import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { resolveLocalIdentity } from '../services/local-identity.service.js';
import { upsertUserAndWorkspace } from '../services/auth.service.js';

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('unauthorized', 'Sign in required.', 401);
    }
    const token = header.slice(7).trim();
    const identity = resolveLocalIdentity(token);
    const bootstrap = await upsertUserAndWorkspace(identity);

    const membership = await prisma.workspaceMember.findFirst({
      where: {
        userId: bootstrap.user.id,
        workspaceId: bootstrap.workspace.id,
      },
    });
    if (!membership) {
      throw new AppError('forbidden', 'No workspace membership.', 403);
    }

    req.auth = {
      userId: bootstrap.user.id,
      authKey: bootstrap.user.authKey,
      email: bootstrap.user.email,
      workspaceId: bootstrap.workspace.id,
      workspaceRole: membership.role,
      fullName: bootstrap.user.fullName,
    };
    next();
  } catch (error) {
    next(error);
  }
}
