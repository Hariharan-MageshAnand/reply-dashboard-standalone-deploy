import { prisma } from '../lib/prisma.js';

/**
 * Warm-up / test-email noise filtering. Sequencing tools send automated
 * warm-up traffic through the same mailboxes; matching threads are flagged at
 * ingestion and kept out of the inbox (and away from the AI classifier).
 * Keywords are workspace-configurable in Settings.
 */
export function matchesWarmupKeywords(keywords: string[], ...texts: Array<string | null>): boolean {
  if (!keywords.length) return false;
  const haystack = texts
    .filter((t): t is string => Boolean(t))
    .join('\n')
    .toLowerCase();
  if (!haystack) return false;
  return keywords.some((k) => {
    const needle = k.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

export async function getWarmupKeywords(workspaceId: string): Promise<string[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { warmupKeywords: true },
  });
  return workspace?.warmupKeywords ?? [];
}

function normalizeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 100);
}

/**
 * Saves the keyword list and re-applies it to every existing conversation in
 * the workspace (both directions: newly-matching threads are hidden,
 * no-longer-matching threads come back).
 */
export async function updateWarmupKeywords(workspaceId: string, keywords: string[]) {
  const normalized = normalizeKeywords(keywords);
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { warmupKeywords: normalized },
  });

  // Ingestion matches against each message's subject AND full body text, so
  // the retroactive pass must inspect the same material — subject/snippet
  // alone misses keywords that only appear past the snippet boundary.
  const conversations = await prisma.conversation.findMany({
    where: { workspaceId },
    select: {
      id: true,
      subject: true,
      snippet: true,
      isWarmup: true,
      messages: { select: { subject: true, bodyText: true } },
    },
  });
  const toHide: string[] = [];
  const toShow: string[] = [];
  for (const c of conversations) {
    const matches =
      matchesWarmupKeywords(normalized, c.subject, c.snippet) ||
      c.messages.some((m) => matchesWarmupKeywords(normalized, m.subject, m.bodyText));
    if (matches && !c.isWarmup) toHide.push(c.id);
    if (!matches && c.isWarmup) toShow.push(c.id);
  }
  if (toHide.length) {
    await prisma.conversation.updateMany({
      where: { id: { in: toHide } },
      data: { isWarmup: true },
    });
  }
  if (toShow.length) {
    await prisma.conversation.updateMany({
      where: { id: { in: toShow } },
      data: { isWarmup: false },
    });
  }
  return { keywords: normalized, hidden: toHide.length, restored: toShow.length };
}
