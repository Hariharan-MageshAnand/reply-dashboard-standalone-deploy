/**
 * Re-run the AI classifier over threads that were labeled by the no-key
 * fallback ("Classifier unavailable — routed to manual review").
 *
 * Fallback rows are the ones with model = NULL; operator-corrected rows are
 * kept untouched. Warm-up conversations are excluded at selection, so their
 * fallback rows are never deleted — deleting without reclassifying would
 * erase their classification/audit data. Every selected fallback message is
 * reclassified (not only the conversation's newest inbound). A row is only
 * dropped after its replacement classification is persisted; a classify
 * failure restores the original fallback row.
 *
 * Run from backend/:  npx tsx scripts/reclassify-fallback.ts
 */
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { classifyInboundMessage } from '../src/services/ai.service.js';

const CONCURRENCY = 3;

export async function reclassifyFallback(options: {
  workspaceId?: string;
  classify?: (messageId: string) => Promise<{ finalLabel: string }>;
} = {}) {
  const classify = options.classify ?? classifyInboundMessage;
  const workspaceScope = options.workspaceId ? { workspaceId: options.workspaceId } : {};
  const fallbackWhere = { model: null, correctedById: null, correctedAt: null };

  const fallbackRows = await prisma.replyClassification.findMany({
    where: { ...fallbackWhere, conversation: { isWarmup: false, ...workspaceScope } },
  });
  const skippedWarmup = await prisma.replyClassification.count({
    where: { ...fallbackWhere, conversation: { isWarmup: true, ...workspaceScope } },
  });

  const labelCounts: Record<string, number> = {};
  if (fallbackRows.length === 0) {
    return { deleted: 0, conversations: 0, reclassified: 0, failed: 0, skippedWarmup, labelCounts };
  }

  const conversationIds = [...new Set(fallbackRows.map((r) => r.conversationId))];
  const messages = await prisma.message.findMany({
    where: { id: { in: fallbackRows.map((r) => r.messageId) } },
    select: { id: true, sentAt: true },
  });
  const sentAtById = new Map(messages.map((m) => [m.id, m.sentAt] as const));
  const ordered = [...fallbackRows].sort((a, b) => {
    const aAt = sentAtById.get(a.messageId)?.getTime() ?? 0;
    const bAt = sentAtById.get(b.messageId)?.getTime() ?? 0;
    return aAt - bAt || a.messageId.localeCompare(b.messageId);
  });

  let deleted = 0;
  let failed = 0;
  let done = 0;
  const queue = [...ordered];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        await prisma.replyClassification.deleteMany({ where: { id: row.id } });
        try {
          const c = await classify(row.messageId);
          labelCounts[c.finalLabel] = (labelCounts[c.finalLabel] ?? 0) + 1;
          deleted += 1;
        } catch (err) {
          failed += 1;
          console.error(`  classify failed for message ${row.messageId}:`, (err as Error).message);
          await prisma.replyClassification.create({
            data: {
              id: row.id,
              conversationId: row.conversationId,
              messageId: row.messageId,
              aiLabel: row.aiLabel,
              aiConfidence: row.aiConfidence,
              aiRationale: row.aiRationale,
              finalLabel: row.finalLabel,
              extractedMetadata: row.extractedMetadata ?? undefined,
              model: row.model,
              correctedById: row.correctedById,
              correctedAt: row.correctedAt,
              createdAt: row.createdAt,
            },
          });
        }
        done += 1;
        if (done % 10 === 0) console.log(`  ${done}/${ordered.length}…`);
      }
    }),
  );

  return {
    deleted,
    conversations: conversationIds.length,
    reclassified: done - failed,
    failed,
    skippedWarmup,
    labelCounts,
  };
}

// CLI entry — skipped when the module is imported (e.g. by the test suite).
if (process.argv[1]?.includes('reclassify-fallback')) {
  (async () => {
    if (!env.AI_READY) {
      console.error('ANTHROPIC_API_KEY is not set — nothing to reclassify with.');
      process.exitCode = 1;
      return;
    }
    const r = await reclassifyFallback();
    console.log(
      `Deleted ${r.deleted} fallback rows across ${r.conversations} conversations ` +
        `(${r.skippedWarmup} warm-up fallback rows left untouched).`,
    );
    console.log(
      `Reclassified ${r.reclassified} messages across ${r.conversations} conversations (${r.failed} failed).`,
    );
    console.log('Label distribution:', r.labelCounts);
  })()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
