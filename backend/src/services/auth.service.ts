import type { BootstrapResponse, UserProfile, WorkspaceSummary } from '@reply/contracts';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import type { LocalIdentity } from './local-identity.service.js';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export async function upsertUserAndWorkspace(identity: LocalIdentity): Promise<BootstrapResponse> {
  const user = await prisma.user.upsert({
    where: { authKey: identity.authKey },
    create: {
      authKey: identity.authKey,
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
      fullName: identity.fullName,
      profilePhotoUrl: identity.profilePhotoUrl,
    },
    update: {
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
      fullName: identity.fullName,
      profilePhotoUrl: identity.profilePhotoUrl,
    },
  });

  let membership = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { createdAt: 'asc' },
  });

  let needsOnboarding = false;

  const DEFAULT_LABELS = [
    { name: 'Hot lead', color: '#6B9137' },
    { name: 'Follow up', color: '#C3B960' },
    { name: 'Not interested', color: '#787D77' },
  ];

  if (!membership && env.WORKSPACE_MODE === 'shared') {
    // Pilot model: one shared team workspace. Whoever signs in joins the
    // existing workspace (with its connected mailboxes and threads) instead of
    // getting an empty personal silo. Join-or-create runs under one global
    // advisory lock so concurrent first sign-ins on an empty database
    // serialize: exactly one creates the workspace, the rest join it.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(730511)`;
      let workspace = await tx.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
      let created = false;
      if (workspace) {
        await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, userId: user.id, role: 'member' },
        });
      } else {
        workspace = await tx.workspace.create({
          data: {
            name: 'Emergence',
            slug: `team-${user.id.slice(-6)}`,
            members: { create: { userId: user.id, role: 'owner' } },
            labels: { create: DEFAULT_LABELS },
          },
        });
        created = true;
      }
      const row = await tx.workspaceMember.findFirstOrThrow({
        where: { workspaceId: workspace.id, userId: user.id },
        include: { workspace: true },
      });
      return { row, created };
    });
    membership = result.row;
    needsOnboarding = result.created;
  }

  if (!membership) {
    const base = slugify(identity.email.split('@')[0] || 'workspace') || 'workspace';
    const workspace = await prisma.workspace.create({
      data: {
        name: `${identity.firstName || 'My'} Workspace`,
        slug: `${base}-${user.id.slice(-6)}`,
        members: {
          create: {
            userId: user.id,
            role: 'owner',
          },
        },
        labels: {
          create: DEFAULT_LABELS,
        },
      },
    });
    membership = await prisma.workspaceMember.findFirstOrThrow({
      where: { workspaceId: workspace.id, userId: user.id },
      include: { workspace: true },
    });
    needsOnboarding = true;
  }

  const mailboxCount = await prisma.senderMailbox.count({
    where: {
      workspaceId: membership.workspaceId,
      disconnectedAt: null,
    },
  });
  needsOnboarding = needsOnboarding || mailboxCount === 0;

  const profile: UserProfile = {
    id: user.id,
    authKey: user.authKey,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: user.fullName,
    profilePhotoUrl: user.profilePhotoUrl,
  };

  const workspace: WorkspaceSummary = {
    id: membership.workspace.id,
    name: membership.workspace.name,
    slug: membership.workspace.slug,
    role: membership.role,
    warmupKeywords: membership.workspace.warmupKeywords,
    slaMinutes: membership.workspace.slaMinutes,
    sourcingLeadEmail: membership.workspace.sourcingLeadEmail,
  };

  return { user: profile, workspace, needsOnboarding };
}

export async function writeAudit(input: {
  workspaceId: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
    },
  });
}
