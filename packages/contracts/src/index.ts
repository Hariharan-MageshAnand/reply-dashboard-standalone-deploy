export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'oauth_failed'
  | 'oauth_not_configured'
  | 'invalid_provider'
  | 'provider_error'
  | 'mailbox_revoked'
  | 'sync_gap'
  | 'reply_failed'
  | 'conflict'
  | 'approval_pending'
  | 'rate_limited'
  | 'internal_error';

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  fields?: Record<string, string>;
  recovery?: string;
}

export interface UserProfile {
  id: string;
  authKey: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  profilePhotoUrl: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  /** Threads matching any of these keywords are flagged as warm-up noise and hidden from the inbox. */
  warmupKeywords: string[];
  /** Minutes a reply may wait unresponded before the SLA breach tag appears. */
  slaMinutes: number;
  /** Where approval-request emails go (pilot: one Lead per workspace). */
  sourcingLeadEmail: string | null;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  warmupKeywords?: string[];
  slaMinutes?: number;
  sourcingLeadEmail?: string | null;
}

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface BootstrapResponse {
  user: UserProfile;
  workspace: WorkspaceSummary;
  needsOnboarding: boolean;
}

export type MailboxHealth =
  | 'healthy'
  | 'syncing'
  | 'auth_required'
  | 'error'
  | 'disconnected';

export type MailboxProvider = 'google' | 'microsoft';

export type MailboxCapability = 'read' | 'modify' | 'send';

export interface SenderMailbox {
  id: string;
  email: string;
  displayName: string | null;
  provider: MailboxProvider;
  health: MailboxHealth;
  capabilities: MailboxCapability[];
  unreadCount: number;
  lastSyncedAt: string | null;
  syncLagSeconds: number | null;
  lastError: string | null;
  connectedAt: string;
}

export interface LoginResponse {
  token: string;
  bootstrap: BootstrapResponse;
}

export type ConversationStatus = 'open' | 'snoozed' | 'archived' | 'closed';
export type ReplyStatus = 'awaiting_reply' | 'replied' | 'needs_attention' | 'none';

/** Fixed internal taxonomy (PRD Section 7) — independent of platform labels. */
export type ReplyLabel =
  | 'interested'
  | 'interested_more_info'
  | 'not_interested'
  | 'ooo'
  | 'wrong_person'
  | 'unsubscribe'
  | 'auto_reply'
  | 'needs_review';

export interface ClassificationView {
  /** The AI's original call — immutable, never overwritten. */
  aiLabel: ReplyLabel;
  aiConfidence: number;
  aiRationale: string | null;
  /** What drives the UI and downstream logic; needs_review under the threshold, operator-correctable. */
  finalLabel: ReplyLabel;
  extractedMetadata: { return_date?: string; redirect_contact_name?: string } | null;
  corrected: boolean;
  classifiedAt: string;
}

export interface AiDraftView {
  id: string;
  draftText: string;
  instruction: string | null;
  /** True when the AI was unavailable and a template fallback was used. */
  isFallback: boolean;
  createdAt: string;
}

export interface CorrectLabelRequest {
  label: ReplyLabel;
}

export interface GenerateDraftRequest {
  instruction?: string;
}

export interface ConversationListItem {
  id: string;
  mailboxId: string;
  mailboxEmail: string;
  subject: string;
  snippet: string;
  participants: ConversationParticipant[];
  unread: boolean;
  status: ConversationStatus;
  replyStatus: ReplyStatus;
  snoozedUntil: string | null;
  /** Set when a scheduled send is pending for this conversation. */
  scheduledFor: string | null;
  /** Current taxonomy label (final_label of the latest classification). */
  label: ReplyLabel | null;
  /** Redirect contact from a wrong_person reply, when extracted. */
  redirectName: string | null;
  /** True when the thread matched the workspace's warm-up noise keywords. */
  isWarmup: boolean;
  /** Set while the reply has waited unresponded past the SLA threshold; clears on response. */
  slaBreachedAt: string | null;
  labels: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  lastMessageAt: string;
  outreachCampaign: string | null;
  messageCount: number;
}

export type OutboundSendStatus = 'sending' | 'sent' | 'failed';

export type ScheduledSendStatus = 'scheduled' | 'sent' | 'cancelled' | 'failed';

export interface ScheduledSendView {
  id: string;
  scheduledFor: string;
  status: ScheduledSendStatus;
  /** 'cancelled_by_operator' or 'auto_cancelled_new_reply' when status is 'cancelled'. */
  cancelReason: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface ScheduleSendRequest {
  bodyHtml: string;
  bodyText: string;
  scheduledFor: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'overridden';

export interface ApprovalCommentView {
  commentText: string | null;
  createdAt: string;
}

export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  sentToEmail: string;
  requestedAt: string;
  reminderSentAt: string | null;
  resolvedAt: string | null;
  /** Append-only, oldest first — every round of Lead feedback survives (PRD 7.3). */
  comments: ApprovalCommentView[];
  /** True once 24h have passed with no Lead response. */
  canOverride: boolean;
}

/**
 * Derived from the conversation's most recent send attempt.
 * - 'sending' means the provider has not definitively accepted or rejected the
 *   send; the Send action must stay disabled until this resolves.
 * - 'failed' is a confirmed provider rejection; retrying is safe.
 */
export interface SendState {
  status: 'idle' | OutboundSendStatus;
  errorMessage: string | null;
  updatedAt: string | null;
}

export interface ConversationParticipant {
  email: string;
  name: string | null;
  role: 'from' | 'to' | 'cc' | 'bcc';
}

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MessageView {
  id: string;
  gmailMessageId: string;
  direction: 'inbound' | 'outbound';
  from: ConversationParticipant;
  to: ConversationParticipant[];
  cc: ConversationParticipant[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  sentAt: string;
  attachments: MessageAttachment[];
}

export interface ConversationDetail extends ConversationListItem {
  messages: MessageView[];
  draft: ReplyDraft | null;
  sendState: SendState;
  /** Latest scheduled-send record — pending, or recently cancelled/failed for visibility. */
  scheduledSend: ScheduledSendView | null;
  classification: ClassificationView | null;
  latestAiDraft: AiDraftView | null;
  /** Latest approval request — pending blocks Send; resolved shown for context. */
  approval: ApprovalView | null;
}

export interface ReplyDraft {
  id: string;
  conversationId: string;
  bodyHtml: string;
  bodyText: string;
  updatedAt: string;
}

export interface ConversationFilters {
  mailboxId?: string;
  unread?: boolean;
  status?: ConversationStatus;
  replyStatus?: ReplyStatus;
  replyLabel?: ReplyLabel;
  label?: string;
  assigneeId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  /** True shows ONLY warm-up noise; default hides it everywhere. */
  warmup?: boolean;
}

export interface ConversationListResponse {
  items: ConversationListItem[];
  nextCursor: string | null;
  totalUnread: number;
}

export interface AssignConversationRequest {
  assigneeId: string | null;
}

export interface UpdateConversationStatusRequest {
  status: ConversationStatus;
  /** Required when status is 'snoozed'; ignored otherwise. */
  snoozedUntil?: string;
}

export interface UpdateLabelsRequest {
  labels: string[];
}

export interface SaveDraftRequest {
  bodyHtml: string;
  bodyText: string;
}

export interface SendReplyRequest {
  bodyHtml: string;
  bodyText: string;
  idempotencyKey: string;
}

export interface SendReplyResponse {
  message: MessageView;
  conversation: ConversationListItem;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  timestamp: string;
}
