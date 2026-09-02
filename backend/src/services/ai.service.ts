import Anthropic from '@anthropic-ai/sdk';
import type { ReplyLabel } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

// Models per PRD Section 9: Haiku for intent classification, Sonnet for drafts.
const CLASSIFIER_MODEL = 'claude-haiku-4-5';
const DRAFT_MODEL = 'claude-sonnet-4-6';

// PRD 5.3: below this, the reply routes to the Needs Review queue.
export const CONFIDENCE_THRESHOLD = 0.7;

// Test-only seam: pause after selecting the classification to correct, so a
// newer inbound can be classified in that gap (label-write race).
export const aiTestHooks: {
  afterCorrectionSelect?: () => Promise<void>;
  /** Inject generated draft text (skips the model) so HTML-escaping can be tested. */
  draftTextOverride?: string;
} = {};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function draftToBodyHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`;
}

// PRD 5.1 inbox ordering: Interested → Interested: More Info → Needs Review → rest.
const LABEL_PRIORITY: Record<ReplyLabel, number> = {
  interested: 0,
  interested_more_info: 1,
  needs_review: 2,
  ooo: 3,
  wrong_person: 3,
  not_interested: 3,
  unsubscribe: 3,
  auto_reply: 3,
};

export function labelPriority(label: ReplyLabel): number {
  return LABEL_PRIORITY[label];
}

async function applyCurrentLabelIfNewest(
  conversationId: string,
  messageId: string,
  label: ReplyLabel,
) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
    const newestInbound = await tx.message.findFirst({
      where: { conversationId, direction: 'inbound' },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (newestInbound?.id !== messageId) return;
    await tx.conversation.update({
      where: { id: conversationId },
      data: { currentLabel: label, labelPriority: labelPriority(label) },
    });
  });
}

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!env.AI_READY) return null;
  anthropicClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

const CLASSIFY_SYSTEM = `You classify replies to B2B cold-outreach emails for a sourcing team. Read the actual reply text and assign exactly one label from this fixed taxonomy:

- interested: wants to engage — asks for a call, meeting, or says yes.
- interested_more_info: engaged but asks for materials or details first (deck, one-pager, "send more info").
- not_interested: clear decline or rejection.
- ooo: out-of-office auto-response, possibly with a return date.
- wrong_person: says they are not the right contact, possibly naming who is.
- unsubscribe: asks to stop receiving emails / remove from list. This is a delivery preference, NOT a rejection.
- auto_reply: automated non-OOO response (ticket systems, generic auto-acks).
- needs_review: genuinely ambiguous — confused, mixed signals, or no clear intent.

Rules:
- Judge from the reply text itself. Platform or subject hints are secondary.
- confidence is 0 to 1: how certain you are of the label.
- rationale: one short sentence a human operator will read to understand your call.
- return_date: ISO date (YYYY-MM-DD) only when an OOO reply states when they are back, else "".
- redirect_contact_name: the person a wrong_person reply points to, else "".`;

const CLASSIFY_SCHEMA = {
  type: 'object' as const,
  properties: {
    label: {
      type: 'string' as const,
      enum: [
        'interested',
        'interested_more_info',
        'not_interested',
        'ooo',
        'wrong_person',
        'unsubscribe',
        'auto_reply',
        'needs_review',
      ],
    },
    confidence: {
      type: 'number' as const,
      description: 'Certainty of the label, between 0 and 1.',
    },
    rationale: { type: 'string' as const },
    return_date: { type: 'string' as const },
    redirect_contact_name: { type: 'string' as const },
  },
  required: ['label', 'confidence', 'rationale', 'return_date', 'redirect_contact_name'],
  additionalProperties: false,
};

interface ClassifierOutput {
  label: ReplyLabel;
  confidence: number;
  rationale: string;
  return_date: string;
  redirect_contact_name: string;
}

async function runClassifier(input: {
  replyBody: string;
  subject: string;
  fromName: string | null;
  fromEmail: string;
  campaign: string | null;
}): Promise<{ output: ClassifierOutput; model: string } | null> {
  const client = getClient();
  if (!client) return null;

  const context = [
    `Subject: ${input.subject}`,
    `From: ${input.fromName ?? ''} <${input.fromEmail}>`,
    input.campaign ? `Campaign: ${input.campaign}` : null,
    '',
    'Reply text:',
    input.replyBody.slice(0, 6000),
  ]
    .filter((line) => line !== null)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 1024,
      system: CLASSIFY_SYSTEM,
      output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
      messages: [{ role: 'user', content: context }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as ClassifierOutput;
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));
    return { output: parsed, model: response.model };
  } catch (error) {
    // PRD 5.3 edge case: classifier failure must never drop the reply — the
    // caller falls back to needs_review.
    console.error('classifier call failed', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Classifies the given inbound message. Idempotent: the first classification is
 * immutable (ai_label is never overwritten); re-runs return the existing row.
 */
export async function classifyInboundMessage(messageId: string) {
  const existing = await prisma.replyClassification.findUnique({ where: { messageId } });
  if (existing) return existing;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { outreachCampaign: true } } },
  });
  if (!message) throw new AppError('not_found', 'Message not found.', 404);
  if (message.direction !== 'inbound') {
    throw new AppError('validation_error', 'Only inbound replies are classified.', 400);
  }

  const result = await runClassifier({
    replyBody: message.bodyText ?? message.subject,
    subject: message.subject,
    fromName: message.fromName,
    fromEmail: message.fromEmail,
    campaign: message.conversation.outreachCampaign?.name ?? null,
  });

  const aiLabel: ReplyLabel = result?.output.label ?? 'needs_review';
  const aiConfidence = result?.output.confidence ?? 0;
  const finalLabel: ReplyLabel = aiConfidence >= CONFIDENCE_THRESHOLD ? aiLabel : 'needs_review';
  const metadata: Record<string, string> = {};
  if (result?.output.return_date) metadata.return_date = result.output.return_date;
  if (result?.output.redirect_contact_name) {
    metadata.redirect_contact_name = result.output.redirect_contact_name;
  }

  let classification;
  try {
    classification = await prisma.replyClassification.create({
      data: {
        conversationId: message.conversationId,
        messageId,
        aiLabel,
        aiConfidence,
        aiRationale:
          result?.output.rationale ??
          'Classifier unavailable — routed to manual review.',
        finalLabel,
        extractedMetadata: Object.keys(metadata).length ? metadata : undefined,
        model: result?.model ?? null,
      },
    });
  } catch (error) {
    // Unique messageId violation: a concurrent classify (the queued worker job
    // racing a manual "Classify now") won the create. The first classification
    // is immutable, so return the winner's row; only the invocation that
    // created a row proceeds to the conversation-label update below.
    if ((error as { code?: string }).code === 'P2002') {
      const winner = await prisma.replyClassification.findUnique({ where: { messageId } });
      if (winner) return winner;
    }
    throw error;
  }

  // Only the newest inbound reply drives the conversation's visible label.
  // Classify jobs run concurrently and can finish out of order — a slower job
  // for an OLDER reply must never overwrite the newer reply's label. The
  // conversation-row lock serializes this write against corrections too.
  await applyCurrentLabelIfNewest(message.conversationId, messageId, finalLabel);

  return classification;
}

/**
 * Operator confirms or corrects the label on the conversation's latest
 * classification. ai_label stays untouched forever; final_label drives
 * everything downstream (PRD 5.3).
 */
export async function correctConversationLabel(
  workspaceId: string,
  conversationId: string,
  label: ReplyLabel,
  correctedById: string,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);

  // Corrections apply to the newest inbound reply's classification (message
  // chronology — not whichever classification row happened to be written last).
  const newestInbound = await prisma.message.findFirst({
    where: { conversationId, direction: 'inbound' },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  const latest = newestInbound
    ? await prisma.replyClassification.findUnique({ where: { messageId: newestInbound.id } })
    : null;
  if (!latest) {
    throw new AppError('not_found', 'The newest reply has no classification yet.', 404);
  }
  if (aiTestHooks.afterCorrectionSelect) await aiTestHooks.afterCorrectionSelect();

  await prisma.replyClassification.update({
    where: { id: latest.id },
    data: { finalLabel: label, correctedById, correctedAt: new Date() },
  });
  // The row correction always sticks (audit). The conversation's visible label
  // only moves if this message is still the canonical newest inbound at commit.
  await applyCurrentLabelIfNewest(conversationId, latest.messageId, label);
}

const DRAFT_SYSTEM = `You draft replies for a venture sourcing operator responding to inbound replies to cold outreach. Write the response the operator would send.

Rules:
- Plain text email body only. No subject line, no signature block beyond a simple sign-off with the sender's first name if known.
- Concise and warm-professional: 2-5 short sentences.
- Match the thread: reply to what the prospect actually said.
- Goal for interested replies: agree to share context and move toward a short intro call.
- Never fabricate specifics you don't have (pricing, valuations, portfolio details, attachments). If asked for something you can't ground, defer gracefully: offer to cover it on a call.
- If the reply asked a question you can answer from the thread, answer it directly.`;

const FALLBACK_TEMPLATE = (firstName: string | null) =>
  `Hi${firstName ? ` ${firstName}` : ''},

Thanks for getting back to me — happy to share more. Would a quick 20-minute call this week or next work on your side? Glad to work around your schedule.

Best`;

/**
 * Generates an AI draft for the conversation. Stores the AI's text immutably
 * (AiDraft) and copies it into the editable working draft (ReplyDraft). On any
 * AI failure a template fallback is used — never a blank editor (PRD 5.4).
 */
export async function generateConversationDraft(input: {
  workspaceId: string;
  conversationId: string;
  authorId: string;
  instruction?: string;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    include: {
      mailbox: true,
      messages: { orderBy: { sentAt: 'desc' }, take: 8 },
      classifications: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!conversation) throw new AppError('not_found', 'Conversation not found.', 404);

  const latestInbound = conversation.messages.find((m) => m.direction === 'inbound');
  const prospectFirstName =
    latestInbound?.fromName?.split(/\s+/)[0] ??
    latestInbound?.fromEmail.split('@')[0] ??
    null;
  const senderFirstName = conversation.mailbox.displayName?.split(/\s+/)[0] ?? null;

  const thread = [...conversation.messages]
    .reverse()
    .map(
      (m) =>
        `[${m.direction === 'inbound' ? 'PROSPECT' : 'US'}] ${m.fromName ?? m.fromEmail}:\n${(m.bodyText ?? '').slice(0, 2000)}`,
    )
    .join('\n\n---\n\n');

  const label = conversation.classifications[0]?.finalLabel ?? null;

  let draftText: string | null = aiTestHooks.draftTextOverride ?? null;
  let model: string | null = null;
  const client = getClient();
  if (!draftText && client) {
    try {
      const response = await client.messages.create({
        model: DRAFT_MODEL,
        max_tokens: 1024,
        system: DRAFT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              `Subject: ${conversation.subject}`,
              label ? `Classified intent: ${label}` : null,
              senderFirstName ? `Sender first name (for sign-off): ${senderFirstName}` : null,
              input.instruction ? `Operator instruction for this draft: ${input.instruction}` : null,
              '',
              'Thread (oldest first):',
              thread,
              '',
              'Write the reply body now.',
            ]
              .filter((line) => line !== null)
              .join('\n'),
          },
        ],
      });
      draftText = response.content.find((b) => b.type === 'text')?.text?.trim() ?? null;
      model = response.model;
    } catch (error) {
      console.error('draft generation failed', error instanceof Error ? error.message : error);
    }
  }

  const isFallback = !draftText;
  draftText ??= FALLBACK_TEMPLATE(prospectFirstName);

  const aiDraft = await prisma.aiDraft.create({
    data: {
      conversationId: conversation.id,
      draftText,
      instruction: input.instruction ?? null,
      model: isFallback ? 'template_fallback' : model,
    },
  });

  await prisma.replyDraft.upsert({
    where: { conversationId: conversation.id },
    create: {
      conversationId: conversation.id,
      authorId: input.authorId,
      bodyHtml: draftToBodyHtml(draftText),
      bodyText: draftText,
    },
    update: {
      bodyHtml: draftToBodyHtml(draftText),
      bodyText: draftText,
      authorId: input.authorId,
    },
  });

  return aiDraft;
}
