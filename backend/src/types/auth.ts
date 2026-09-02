import type { Request } from 'express';
import type { WorkspaceRole } from '@prisma/client';

export interface AuthContext {
  userId: string;
  authKey: string;
  email: string;
  workspaceId: string;
  workspaceRole: WorkspaceRole;
  fullName: string | null;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new Error('Missing auth context');
  }
  return req.auth;
}
