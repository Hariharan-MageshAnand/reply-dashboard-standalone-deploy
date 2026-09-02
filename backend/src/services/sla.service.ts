import { prisma } from '../lib/prisma.js';

/**
 * SLA breach tagging (PRD 5.8). A background job stamps conversations that
 * have waited on a reply past the workspace threshold; the tag clears
 * automatically the moment a response goes out (see send.service /
 * message-store). The visible tag is the primary signal — Lead notification
 * rides on top once the transactional email provider lands (approval flow).
 */
export async function tagSlaBreaches(now = new Date()) {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, slaMinutes: true },
  });

  let tagged = 0;
  for (const workspace of workspaces) {
    const cutoff = new Date(now.getTime() - workspace.slaMinutes * 60_000);
    const result = await prisma.conversation.updateMany({
      where: {
        workspaceId: workspace.id,
        status: 'open',
        replyStatus: 'awaiting_reply',
        isWarmup: false,
        slaBreachedAt: null,
        lastMessageAt: { lte: cutoff },
      },
      data: { slaBreachedAt: now },
    });
    tagged += result.count;
  }
  return tagged;
}
