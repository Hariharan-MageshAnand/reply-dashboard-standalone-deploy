import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  BarChart2,
  Bell,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Clock,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import type {
  ConversationDetail,
  ConversationStatus,
  ReplyLabel,
  SenderMailbox,
} from '@reply/contracts';
import { useSession } from '../lib/session';
import { conversationApi, mailboxApi } from '../lib/services';
import { ApiClientError } from '../lib/api';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToBodyHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`;
}

const REPLY_LABELS: Record<ReplyLabel, { text: string; className: string; style?: React.CSSProperties }> = {
  interested: { text: 'Interested', className: 'badge badge-ok' },
  interested_more_info: { text: 'More info', className: 'badge badge-ok' },
  needs_review: { text: 'Needs review', className: 'badge badge-warn' },
  wrong_person: {
    text: 'Wrong person',
    className: 'badge',
    style: { background: 'rgba(124, 96, 180, 0.16)', color: '#5b4693' },
  },
  not_interested: { text: 'Not interested', className: 'badge' },
  ooo: { text: 'Out of office', className: 'badge' },
  unsubscribe: { text: 'Unsubscribed', className: 'badge badge-danger' },
  auto_reply: { text: 'Auto reply', className: 'badge', style: { opacity: 0.7 } },
};

function LabelBadge({ label }: { label: ReplyLabel | null }) {
  if (!label) return null;
  const config = REPLY_LABELS[label];
  return (
    <span className={config.className} style={config.style}>
      {config.text}
    </span>
  );
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

type ListStatus = Extract<ConversationStatus, 'open' | 'snoozed' | 'archived'>;

function atHour(daysAhead: number, hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nextMonday9am() {
  const d = new Date();
  const daysUntilMonday = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + daysUntilMonday);
  d.setHours(9, 0, 0, 0);
  return d;
}

const SNOOZE_PRESETS: Array<{ label: string; until: () => Date }> = [
  { label: '30 minutes', until: () => new Date(Date.now() + 30 * 60_000) },
  { label: '2 hours', until: () => new Date(Date.now() + 2 * 3600_000) },
  { label: '4 hours', until: () => new Date(Date.now() + 4 * 3600_000) },
  { label: 'Tomorrow 9am', until: () => atHour(1, 9) },
  { label: 'Tomorrow 2pm', until: () => atHour(1, 14) },
  { label: '2 days', until: () => atHour(2, 9) },
  { label: '3 days', until: () => atHour(3, 9) },
  { label: '4 days', until: () => atHour(4, 9) },
  { label: '1 week', until: () => atHour(7, 9) },
  { label: '2 weeks', until: () => atHour(14, 9) },
  { label: '1 month', until: () => atHour(30, 9) },
  { label: '3 months', until: () => atHour(90, 9) },
];

const SEND_LATER_PRESETS: Array<{ label: string; at: () => Date }> = [
  { label: '30 minutes', at: () => new Date(Date.now() + 30 * 60_000) },
  { label: '2 hours', at: () => new Date(Date.now() + 2 * 3600_000) },
  { label: 'Tomorrow 9am', at: () => atHour(1, 9) },
  { label: 'Tomorrow 2pm', at: () => atHour(1, 14) },
  { label: 'Next Monday', at: nextMonday9am },
];

function dateInputToDate(value: string) {
  const d = new Date(`${value}T09:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Dropdown with an invisible backdrop that closes it on any outside click. */
function Menu({
  open,
  onClose,
  children,
  align = 'right',
  direction = 'down',
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
  /** 'up' for triggers at the viewport bottom (composer footer) — a downward menu would be clipped. */
  direction?: 'down' | 'up';
}) {
  if (!open) return null;
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 19 }}
        onClick={onClose}
        aria-hidden
      />
      <div
        role="menu"
        className="card menu-pop"
        style={{
          position: 'absolute',
          [direction === 'up' ? 'bottom' : 'top']: 'calc(100% + 6px)',
          [align]: 0,
          zIndex: 20,
          minWidth: 210,
          // Tall enough for the full snooze preset list — an internal scroll
          // here clips the first rows and reads as broken.
          maxHeight: 'min(480px, 70vh)',
          overflowY: 'auto',
          padding: 6,
          display: 'grid',
          background: 'var(--card-solid)',
        }}
      >
        {children}
      </div>
    </>
  );
}

function MenuItem({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="btn btn-ghost"
      style={{ justifyContent: 'flex-start', minHeight: 31, paddingBlock: 3 }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MenuDateInput({ onPick }: { onPick: (d: Date) => void }) {
  // Collapsed by default: the native calendar popup anchors over the menu and
  // hides the preset rows, so only render the input once it's asked for.
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <MenuItem onClick={() => setOpen(true)}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 8,
          }}
        >
          Pick a date
          <ChevronRight size={14} aria-hidden style={{ opacity: 0.7 }} />
        </span>
      </MenuItem>
    );
  }
  return (
    <input
      type="date"
      className="input"
      autoFocus
      style={{ margin: '4px 6px 2px', width: 'calc(100% - 12px)' }}
      min={new Date().toISOString().slice(0, 10)}
      onChange={(e) => {
        const d = e.target.value ? dateInputToDate(e.target.value) : null;
        if (d && d.getTime() > Date.now()) onPick(d);
      }}
      aria-label="Pick a date"
    />
  );
}

function SyncBanner({ mailboxes }: { mailboxes: SenderMailbox[] }) {
  const broken = mailboxes.filter((m) => m.health === 'error' || m.health === 'auth_required');
  if (!broken.length) return null;
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '10px 16px',
        background: 'rgba(214, 158, 46, 0.14)',
        borderBottom: '1px solid rgba(214, 158, 46, 0.4)',
        fontSize: 13,
      }}
    >
      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
      <div>
        {broken.map((m) => (
          <div key={m.id}>
            <strong>{m.email}</strong> sync unavailable
            {m.health === 'auth_required' ? ' — reconnect required' : ''}.{' '}
            <Link to="/settings/mailboxes">Manage mailboxes</Link>
          </div>
        ))}
      </div>
    </div>
  );
}

const LIST_TITLES: Record<ListStatus, string> = {
  open: 'Inbox',
  snoozed: 'Snoozed',
  archived: 'Archived',
};

function ConversationList({
  selectedId,
  mailboxId,
  unreadOnly,
  q,
  status,
  replyLabel,
  warmup,
  hasFilters,
  onClearFilters,
}: {
  selectedId?: string;
  mailboxId?: string;
  unreadOnly: boolean;
  q: string;
  status: ListStatus;
  replyLabel?: string;
  warmup: boolean;
  hasFilters: boolean;
  onClearFilters: () => void;
}) {
  // Opening a thread must keep the active view params (status/warmup/q…) in
  // the URL, or the list pane snaps back to the default open Inbox.
  const viewSearch = useSearchParams()[0].toString();
  const list = useInfiniteQuery({
    queryKey: ['conversations', { mailboxId, unreadOnly, q, status, replyLabel, warmup }],
    queryFn: ({ pageParam }) =>
      conversationApi.list({
        mailboxId,
        unread: unreadOnly || undefined,
        q: q || undefined,
        // The warm-up view spans all statuses; tabs don't apply there.
        status: warmup ? undefined : status,
        replyLabel: replyLabel || undefined,
        warmup: warmup || undefined,
        cursor: pageParam || undefined,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const totalUnread = list.data?.pages[0]?.totalUnread ?? 0;

  return (
    <div className="list-pane" aria-label="Conversations">
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-soft)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 className="display-title" style={{ margin: 0, fontSize: 17 }}>
            {warmup ? 'Warm-up noise' : LIST_TITLES[status]}
          </h1>
          <span className="badge">{totalUnread} unread</span>
        </div>
        {warmup && (
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
            Threads matching warm-up keywords — hidden from the inbox and skipped by the AI.{' '}
            <Link to="/settings/team">Manage keywords</Link>
          </p>
        )}
      </div>
      <div role="list" style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        {list.isLoading && <p className="muted" style={{ padding: 16 }}>Loading conversations…</p>}
        {!list.isLoading && items.length === 0 && (
          <div style={{ padding: 24 }}>
            <p style={{ fontWeight: 600, marginBottom: 8 }}>
              {hasFilters ? 'No matches for the current filters' : 'Nothing here yet'}
            </p>
            <p className="muted" style={{ marginTop: 0 }}>
              {hasFilters
                ? 'A search or filter is active — conversations that don’t match are hidden.'
                : status === 'open'
                  ? 'Connect mailboxes and sync to pull replies from your outreach accounts.'
                  : `No ${LIST_TITLES[status].toLowerCase()} conversations.`}
            </p>
            {hasFilters ? (
              <button type="button" className="btn btn-secondary" onClick={onClearFilters}>
                <X size={15} />
                Clear filters
              </button>
            ) : (
              status === 'open' && (
                <Link className="btn btn-secondary" to="/settings/mailboxes">
                  Manage mailboxes
                </Link>
              )
            )}
          </div>
        )}
        {items.map((item) => {
          const from =
            item.participants.find((p) => p.role === 'from')?.name ||
            item.participants.find((p) => p.role === 'from')?.email ||
            item.mailboxEmail;
          return (
            <Link
              key={item.id}
              role="listitem"
              to={`/inbox/${item.id}${viewSearch ? `?${viewSearch}` : ''}`}
              className={clsx('conversation-row', {
                selected: item.id === selectedId,
                unread: item.unread,
              })}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontWeight: item.unread ? 700 : 600, fontSize: 13.5 }}>
                  {from}
                </strong>
                <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {timeAgo(item.lastMessageAt)}
                </span>
              </div>
              <div
                style={{
                  fontWeight: item.unread ? 600 : 500,
                  marginTop: 2,
                  fontSize: 13.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.subject}
              </div>
              <div
                className="muted"
                style={{
                  fontSize: 12.5,
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.snippet ? `“${item.snippet}”` : ''}
              </div>
              {(item.redirectName ||
                item.scheduledFor ||
                (item.label &&
                  ['ooo', 'not_interested', 'auto_reply', 'unsubscribe'].includes(item.label) &&
                  item.replyStatus !== 'awaiting_reply')) && (
                <div style={{ fontSize: 12.5, marginTop: 3 }}>
                  {item.redirectName ? (
                    <span style={{ color: '#5b4693' }}>Redirect: {item.redirectName}</span>
                  ) : item.scheduledFor ? (
                    <span className="muted">
                      Re-engagement queued — {formatWhen(item.scheduledFor)}
                    </span>
                  ) : (
                    <span className="muted">No response required</span>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                {item.slaBreachedAt && <span className="badge badge-danger">SLA breach</span>}
                <LabelBadge label={item.label} />
                {item.replyStatus === 'awaiting_reply' && !item.label && (
                  <span className="badge badge-warn">Needs reply</span>
                )}
                {item.replyStatus === 'needs_attention' && (
                  <span className="badge badge-danger">Needs attention</span>
                )}
                {item.snoozedUntil && (
                  <span className="badge">
                    <Clock size={11} aria-hidden /> {formatWhen(item.snoozedUntil)}
                  </span>
                )}
                {item.scheduledFor && (
                  <span className="badge badge-ok">
                    <CalendarClock size={11} aria-hidden /> Queued — {formatWhen(item.scheduledFor)}
                  </span>
                )}
                {item.labels.map((label) => (
                  <span key={label} className="badge badge-ok">
                    {label}
                  </span>
                ))}
                <span className="badge" style={{ opacity: 0.7 }}>{item.mailboxEmail}</span>
              </div>
            </Link>
          );
        })}
        {list.hasNextPage && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
      <style>{`
        .conversation-row {
          display: block;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-soft);
        }
        .conversation-row:hover {
          background: rgba(22, 58, 36, 0.04);
        }
        .conversation-row.selected {
          background: rgba(107, 145, 55, 0.12);
        }
        .conversation-row.unread {
          box-shadow: inset 3px 0 0 var(--foreground);
        }
        .badge { display: inline-flex; align-items: center; gap: 4px; }
      `}</style>
    </div>
  );
}

function ThreadPane({ conversationId }: { conversationId?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Keep the active view (status/warmup/search…) when returning to the list —
  // otherwise closing a thread from Snoozed/Archived dumps you back in Inbox.
  const listSearch = useSearchParams()[0].toString();
  const listPath = listSearch ? `/inbox?${listSearch}` : '/inbox';
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => conversationApi.get(conversationId!),
    enabled: Boolean(conversationId),
    // Poll while something external can resolve: an unresolved send
    // (reconciliation) or a pending approval (the Lead's one-click links).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.sendState.status === 'sending') return 4000;
      if (data?.approval?.status === 'pending') return 5000;
      return false;
    },
  });

  useEffect(() => {
    if (detail.data?.draft?.bodyText) {
      setDraft(detail.data.draft.bodyText);
    } else if (detail.data && !detail.data.draft) {
      setDraft('');
    }
  }, [detail.data?.id, detail.data?.draft?.updatedAt]);

  useEffect(() => {
    setError(null);
    setSnoozeOpen(false);
    setSendMenuOpen(false);
    setAiInstruction('');
  }, [conversationId]);

  useEffect(() => {
    if (detail.data?.unread) {
      void conversationApi.markRead(detail.data.id, false).then(() => {
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      });
    }
  }, [detail.data?.id, detail.data?.unread, conversationId, qc]);

  const saveDraft = useMutation({
    mutationFn: async (text: string) =>
      conversationApi.saveDraft(conversationId!, textToBodyHtml(text), text),
  });

  const onDraftChange = (text: string) => {
    setDraft(text);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraft.mutate(text), 500);
  };

  // One idempotency key per send attempt cycle: reused if the same payload is
  // retried transparently, regenerated once the attempt resolves either way.
  const attemptKey = useRef<string | null>(null);

  const applyDetail = async (data: ConversationDetail) => {
    await qc.invalidateQueries({ queryKey: ['conversations'] });
    qc.setQueryData(['conversation', conversationId], data);
  };

  const sendReply = useMutation({
    mutationFn: async ({ text }: { text: string; archive: boolean }) => {
      attemptKey.current ??= crypto.randomUUID();
      return conversationApi.reply(conversationId!, textToBodyHtml(text), text, attemptKey.current);
    },
    onSuccess: async (data: ConversationDetail, { archive }) => {
      attemptKey.current = null;
      setError(null);
      if (data.sendState.status === 'sent') {
        setDraft('');
        if (archive) {
          await conversationApi.setStatus(conversationId!, 'archived');
          await qc.invalidateQueries({ queryKey: ['conversations'] });
          navigate(listPath);
          return;
        }
      }
      await applyDetail(data);
    },
    onError: async (err) => {
      attemptKey.current = null;
      setError(err instanceof ApiClientError ? err.body.message : 'Failed to send reply');
      await qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
  });

  const scheduleSend = useMutation({
    mutationFn: async ({ text, at }: { text: string; at: Date }) =>
      conversationApi.scheduleSend(conversationId!, textToBodyHtml(text), text, at.toISOString()),
    onSuccess: async (data: ConversationDetail) => {
      setError(null);
      setDraft('');
      await applyDetail(data);
    },
    onError: (err) => {
      setError(err instanceof ApiClientError ? err.body.message : 'Failed to schedule send');
    },
  });

  const cancelSchedule = useMutation({
    mutationFn: async () => conversationApi.cancelScheduledSend(conversationId!),
    onSuccess: applyDetail,
  });

  const archive = useMutation({
    mutationFn: async () => conversationApi.setStatus(conversationId!, 'archived'),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      navigate(listPath);
    },
  });

  const snooze = useMutation({
    mutationFn: async (until: Date) =>
      conversationApi.setStatus(conversationId!, 'snoozed', until.toISOString()),
    onSuccess: async () => {
      setSnoozeOpen(false);
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      navigate(listPath);
    },
    onError: (err) => {
      setSnoozeOpen(false);
      setError(err instanceof ApiClientError ? err.body.message : 'Failed to snooze');
    },
  });

  const unsnooze = useMutation({
    mutationFn: async () => conversationApi.setStatus(conversationId!, 'open'),
    onSuccess: applyDetail,
  });

  const classify = useMutation({
    mutationFn: async () => conversationApi.classify(conversationId!),
    onSuccess: applyDetail,
    onError: (err) => {
      setError(err instanceof ApiClientError ? err.body.message : 'Classification failed');
    },
  });

  const generateDraft = useMutation({
    mutationFn: async (instruction?: string) =>
      conversationApi.generateDraft(conversationId!, instruction),
    onSuccess: async (data: ConversationDetail) => {
      setAiInstruction('');
      setError(null);
      await applyDetail(data);
    },
    onError: (err) => {
      setError(err instanceof ApiClientError ? err.body.message : 'Draft generation failed');
    },
  });

  const overrideApproval = useMutation({
    mutationFn: async () => conversationApi.overrideApproval(conversationId!),
    onSuccess: applyDetail,
    onError: (err) => {
      setError(err instanceof ApiClientError ? err.body.message : 'Override failed');
    },
  });

  if (!conversationId) {
    return (
      <section className="thread-pane" style={{ display: 'grid', placeItems: 'center', padding: 32 }}>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <h2 className="display-title" style={{ marginBottom: 8 }}>
            Select a conversation
          </h2>
          <p className="muted">
            Replies from all connected outreach mailboxes appear here as threads.
          </p>
        </div>
      </section>
    );
  }

  if (detail.isLoading) {
    return (
      <section className="thread-pane" style={{ padding: 24 }}>
        <p className="muted">Loading thread…</p>
      </section>
    );
  }

  if (!detail.data) {
    return (
      <section className="thread-pane" style={{ padding: 24 }}>
        <p role="alert">Conversation not found.</p>
      </section>
    );
  }

  const c = detail.data;
  const approvalPending = c.approval?.status === 'pending';
  const changesRequested = c.approval?.status === 'changes_requested';
  const scheduled = c.scheduledSend?.status === 'scheduled' ? c.scheduledSend : null;
  const autoCancelled =
    !scheduled &&
    c.scheduledSend?.status === 'cancelled' &&
    c.scheduledSend.cancelReason === 'auto_cancelled_new_reply';
  const scheduleFailed = !scheduled && c.scheduledSend?.status === 'failed';
  const sending = c.sendState.status === 'sending';
  const busy = sendReply.isPending || scheduleSend.isPending || sending;
  const canSend = Boolean(draft.trim()) && !busy && !approvalPending;

  const doSend = (archiveAfter: boolean) => {
    if (!canSend) return;
    setSendMenuOpen(false);
    sendReply.mutate({ text: draft.trim(), archive: archiveAfter });
  };
  const doSchedule = (at: Date) => {
    if (!canSend) return;
    setSendMenuOpen(false);
    scheduleSend.mutate({ text: draft.trim(), at });
  };

  return (
    <section
      className="thread-pane"
      aria-label="Conversation thread"
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <header
        style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ minHeight: 30, paddingInline: 6, alignSelf: 'center' }}
              onClick={() => navigate(listPath)}
              aria-label="Back to list"
            >
              <ChevronLeft size={17} />
            </button>
            <h2 className="display-title" style={{ margin: '2px 0', fontSize: 17 }}>
              {c.participants.find((p) => p.role === 'from')?.name || c.participants.find((p) => p.role === 'from')?.email || c.subject}
            </h2>
            <LabelBadge label={c.label} />
            {c.slaBreachedAt && <span className="badge badge-danger">SLA breach</span>}
            {c.replyStatus === 'awaiting_reply' && !c.label && (
              <span className="badge badge-warn">Needs reply</span>
            )}
            {c.replyStatus === 'needs_attention' && (
              <span className="badge badge-danger">Needs attention</span>
            )}
            {c.status === 'snoozed' && c.snoozedUntil && (
              <span className="badge">Snoozed until {formatWhen(c.snoozedUntil)}</span>
            )}
            {c.classification?.aiRationale && (
              <span className="muted" style={{ fontStyle: 'italic', fontSize: 13 }}>
                — {c.classification.aiRationale}
              </span>
            )}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span>
              {c.subject} · via {c.mailboxEmail} · {c.messageCount} messages
            </span>
            {!c.classification && c.messages.some((m) => m.direction === 'inbound') && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ minHeight: 24, paddingInline: 6, fontSize: 12.5 }}
                disabled={classify.isPending}
                onClick={() => classify.mutate()}
              >
                {classify.isPending ? 'Classifying…' : 'Classify now'}
              </button>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, position: 'relative', flexShrink: 0, alignItems: 'center' }}>
          {c.status === 'snoozed' ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => unsnooze.mutate()}
              disabled={unsnooze.isPending}
            >
              <Clock size={16} />
              Unsnooze
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setSnoozeOpen((open) => !open)}
              aria-expanded={snoozeOpen}
              aria-haspopup="menu"
            >
              <Clock size={16} />
              Snooze
              <ChevronDown size={14} />
            </button>
          )}
          <Menu open={snoozeOpen} onClose={() => setSnoozeOpen(false)}>
            {SNOOZE_PRESETS.map((preset) => (
              <MenuItem
                key={preset.label}
                disabled={snooze.isPending}
                onClick={() => snooze.mutate(preset.until())}
              >
                {preset.label}
              </MenuItem>
            ))}
            <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 4, paddingTop: 4 }}>
              <MenuDateInput onPick={(d) => snooze.mutate(d)} />
            </div>
          </Menu>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => archive.mutate()}
            aria-label="Archive conversation"
          >
            <Archive size={16} />
            Archive
          </button>
        </div>
      </header>

      <div style={{ padding: 20, overflow: 'auto', flex: 1, minHeight: 0, display: 'grid', gap: 12, alignContent: 'start' }}>
        {c.messages.map((message) => {
          const senderName = message.from.name || message.from.email;
          const outbound = message.direction === 'outbound';
          return (
            <div
              key={message.id}
              style={{
                display: 'flex',
                gap: 10,
                paddingBottom: 12,
                borderBottom: '1px solid var(--border-soft)',
              }}
            >
              <div className="msg-avatar" aria-hidden>
                {senderName.charAt(0).toUpperCase()}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13.5 }}>{senderName}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    · {timeAgo(message.sentAt)}
                  </span>
                  {outbound && (
                    <span className="badge" style={{ opacity: 0.7 }}>
                      Outbound
                    </span>
                  )}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    whiteSpace: 'pre-wrap',
                    fontSize: 13.5,
                    color: outbound ? 'var(--muted-foreground)' : 'inherit',
                  }}
                >
                  {message.bodyHtml ? (
                    <div dangerouslySetInnerHTML={{ __html: message.bodyHtml }} />
                  ) : (
                    message.bodyText
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <footer
        style={{
          borderTop: '1px solid var(--border-soft)',
          padding: 16,
          background: 'var(--card-solid)',
        }}
      >
        {scheduled ? (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(107, 145, 55, 0.12)',
              border: '1px solid rgba(107, 145, 55, 0.35)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <CalendarClock size={16} aria-hidden />
              Scheduled to send <strong>{formatWhen(scheduled.scheduledFor)}</strong>. Auto-cancels
              if they reply first.
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => cancelSchedule.mutate()}
              disabled={cancelSchedule.isPending}
            >
              Cancel schedule
            </button>
          </div>
        ) : (
          <>
            {approvalPending && c.approval && (
              <div
                role="status"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 10,
                  padding: '10px 14px',
                  borderRadius: 10,
                  background: 'rgba(214, 158, 46, 0.14)',
                  border: '1px solid rgba(214, 158, 46, 0.4)',
                  fontSize: 13.5,
                }}
              >
                <span>
                  <strong>Awaiting sign-off</strong> from {c.approval.sentToEmail} — requested{' '}
                  {formatWhen(c.approval.requestedAt)}. Sending is blocked until they respond.
                  {c.approval.reminderSentAt ? ' Reminder sent.' : ''}
                </span>
                {c.approval.canOverride && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={overrideApproval.isPending}
                    onClick={() => overrideApproval.mutate()}
                  >
                    Override and unblock
                  </button>
                )}
              </div>
            )}
            {changesRequested && c.approval && (
              <div
                role="alert"
                style={{
                  marginBottom: 10,
                  padding: '10px 14px',
                  borderRadius: 10,
                  background: 'rgba(180, 35, 24, 0.07)',
                  border: '1px solid rgba(180, 35, 24, 0.25)',
                  fontSize: 13.5,
                }}
              >
                <strong>Changes requested</strong> by {c.approval.sentToEmail}:
                {c.approval.comments.length ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {c.approval.comments.map((comment, i) => (
                      <li key={i}>
                        {comment.commentText ?? (
                          <em>No comment provided — follow up with them directly.</em>
                        )}{' '}
                        <span className="muted">({formatWhen(comment.createdAt)})</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <em> no comment provided — follow up with them directly.</em>
                )}
                <div className="muted" style={{ marginTop: 4 }}>
                  Revise the draft below, then re-request sign-off.
                </div>
              </div>
            )}
            {c.approval?.status === 'approved' && c.sendState.status !== 'sent' && (
              <p role="status" style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--primary)' }}>
                ✓ Approved by {c.approval.sentToEmail}
                {c.approval.resolvedAt ? ` — ${formatWhen(c.approval.resolvedAt)}` : ''}. You can
                send.
              </p>
            )}
            {autoCancelled && (
              <p
                role="alert"
                style={{
                  margin: '0 0 10px',
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(214, 158, 46, 0.14)',
                  border: '1px solid rgba(214, 158, 46, 0.4)',
                  fontSize: 13,
                }}
              >
                The scheduled send was cancelled — the contact replied again. The message is back in
                the editor below; review it before sending.
              </p>
            )}
            {scheduleFailed && (
              <p role="alert" style={{ color: 'var(--danger)', margin: '0 0 10px', fontSize: 13 }}>
                Scheduled send failed: {c.scheduledSend?.errorMessage ?? 'unknown error'}.
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 12.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)' }}>
                {c.latestAiDraft ? 'AI-drafted response' : 'Response'}
              </span>
              {!c.latestAiDraft && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ minHeight: 32, fontSize: 13 }}
                  disabled={generateDraft.isPending}
                  onClick={() => generateDraft.mutate(undefined)}
                >
                  <Sparkles size={14} />
                  {generateDraft.isPending ? 'Drafting…' : 'Generate AI draft'}
                </button>
              )}
            </div>
            <label style={{ display: 'grid', gap: 6 }}>
              <textarea
                className="textarea"
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                placeholder={generateDraft.isPending ? 'Drafting…' : 'Write a reply…'}
                aria-label="Reply body"
                rows={5}
              />
            </label>
            {c.latestAiDraft && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1, minHeight: 36, fontSize: 13.5 }}
                  placeholder="Tell AI what to change… (e.g. make it less formal)"
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !generateDraft.isPending) {
                      generateDraft.mutate(aiInstruction.trim() || undefined);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ minHeight: 36 }}
                  disabled={generateDraft.isPending}
                  onClick={() => generateDraft.mutate(aiInstruction.trim() || undefined)}
                >
                  <RefreshCw size={14} />
                  {generateDraft.isPending ? 'Drafting…' : 'Regenerate'}
                </button>
              </div>
            )}
            {c.latestAiDraft?.isFallback && (
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
                AI was unavailable — this is a template starter. Edit before sending.
              </p>
            )}
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
              Sends from <strong>{c.mailboxEmail}</strong> — locked to the original thread, no
              override.
            </p>
            {sending && !sendReply.isPending && (
              <p role="status" style={{ margin: '8px 0 0', fontSize: 13 }}>
                Confirming send status… Send stays disabled until the last attempt is confirmed
                delivered or failed — this prevents accidental double-sends.
              </p>
            )}
            {(error || c.sendState.status === 'failed') && (
              <p role="alert" style={{ color: 'var(--danger)', margin: '8px 0 0', fontSize: 13 }}>
                {error ?? c.sendState.errorMessage ?? 'The last send failed.'} Your draft is
                preserved — you can retry.
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 8, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {saveDraft.isSuccess ? (
                  <>
                    <CheckCircle2 size={14} /> Draft saved
                  </>
                ) : (
                  'Drafts autosave to this workspace'
                )}
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <div style={{ position: 'relative', display: 'flex' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                  disabled={!canSend}
                  onClick={() => doSend(true)}
                >
                  <Send size={16} />
                  {sendReply.isPending
                    ? 'Sending…'
                    : sending
                      ? 'Confirming…'
                      : 'Send and archive'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    paddingInline: 8,
                    borderLeft: '1px solid rgba(247,245,238,0.4)',
                  }}
                  aria-label="More send options"
                  aria-haspopup="menu"
                  aria-expanded={sendMenuOpen}
                  disabled={!canSend}
                  onClick={() => setSendMenuOpen((open) => !open)}
                >
                  <ChevronDown size={16} />
                </button>
                <Menu
                  open={sendMenuOpen}
                  direction="up"
                  onClose={() => {
                    setSendMenuOpen(false);
                    setSendLaterOpen(false);
                  }}
                >
                  <MenuItem onClick={() => doSend(false)}>Send</MenuItem>
                  <MenuItem onClick={() => doSend(true)}>Send and archive (default)</MenuItem>
                  {/* Three rows, not two plus a list of presets. "Send later" is one choice
                      among three; spelling its five presets out inline made scheduling look
                      like the bulk of what this button does. */}
                  <MenuItem onClick={() => setSendLaterOpen((open) => !open)}>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        gap: 8,
                      }}
                    >
                      Send later
                      <ChevronRight
                        size={14}
                        aria-hidden
                        style={{
                          transform: sendLaterOpen ? 'rotate(90deg)' : 'none',
                          transition: 'transform 120ms ease',
                          opacity: 0.7,
                        }}
                      />
                    </span>
                  </MenuItem>
                  {sendLaterOpen && (
                    <div style={{ display: 'grid', paddingLeft: 10 }}>
                      {SEND_LATER_PRESETS.map((preset) => (
                        <MenuItem key={preset.label} onClick={() => doSchedule(preset.at())}>
                          {preset.label}
                        </MenuItem>
                      ))}
                      <MenuDateInput onPick={doSchedule} />
                    </div>
                  )}
                </Menu>
              </div>
              </div>
            </div>
          </>
        )}
      </footer>
    </section>
  );
}

/** Everything "Clear all filters" resets — including the status view. */
export const CLEARABLE_FILTER_KEYS = [
  'q',
  'mailboxId',
  'replyLabel',
  'unread',
  'warmup',
  'status',
] as const;

/** True when any clearable filter is active, a non-open status included. */
export function hasActiveInboxFilters(params: URLSearchParams): boolean {
  const status = params.get('status');
  return Boolean(
    params.get('q') ||
      params.get('mailboxId') ||
      params.get('replyLabel') ||
      params.get('unread') === '1' ||
      params.get('warmup') === '1' ||
      status === 'snoozed' ||
      status === 'archived',
  );
}

export function InboxPage() {
  const { conversationId } = useParams();
  const [params, setParams] = useSearchParams();
  const mailboxId = params.get('mailboxId') ?? undefined;
  const unreadOnly = params.get('unread') === '1';
  const statusParam = params.get('status');
  const status: ListStatus =
    statusParam === 'snoozed' || statusParam === 'archived' ? statusParam : 'open';
  const warmupView = params.get('warmup') === '1';
  const { bootstrap, signOut } = useSession();
  const warmupKeywordsActive = (bootstrap?.workspace.warmupKeywords?.length ?? 0) > 0;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const navigate = useNavigate();
  const [q, setQ] = useState(params.get('q') ?? '');
  // A non-default status (Snoozed/Archived) counts as an active filter — the
  // button says "Clear all filters", so it must return the user to the open
  // inbox too, not silently keep the status view.
  const hasActiveFilters = Boolean(q) || hasActiveInboxFilters(params);

  const clearFilters = () => {
    setQ('');
    const next = new URLSearchParams(params);
    for (const key of CLEARABLE_FILTER_KEYS) {
      next.delete(key);
    }
    setParams(next);
  };

  // Debounced search-as-you-type: the URL param drives the query.
  useEffect(() => {
    const timer = setTimeout(() => {
      const current = params.get('q') ?? '';
      if (q === current) return;
      const next = new URLSearchParams(params);
      if (q) next.set('q', q);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [q, params, setParams]);

  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: mailboxApi.list,
    refetchInterval: 20_000,
  });

  const syncAll = useMutation({
    mutationFn: async () => {
      const items = mailboxes.data?.items ?? [];
      await Promise.all(items.map((m) => mailboxApi.sync(m.id)));
    },
  });

  const primaryMailbox = mailboxes.data?.items[0] ?? null;
  const unreadTotal = (mailboxes.data?.items ?? []).reduce((sum, m) => sum + m.unreadCount, 0);
  const setView = (patch: { status?: string; unread?: boolean; warmup?: boolean }) => {
    const next = new URLSearchParams(params);
    if (patch.status !== undefined) {
      if (patch.status === 'open') next.delete('status');
      else next.set('status', patch.status);
      next.delete('warmup');
    }
    if (patch.unread !== undefined) {
      if (patch.unread) next.set('unread', '1');
      else next.delete('unread');
    }
    if (patch.warmup !== undefined) {
      if (patch.warmup) {
        next.set('warmup', '1');
        next.delete('status');
      } else next.delete('warmup');
    }
    setParams(next);
  };
  const brokenCount =
    mailboxes.data?.items.filter((m) => m.health === 'error' || m.health === 'auth_required')
      .length ?? 0;

  return (
    <div className="app-frame">
      <header className="top-bar">
        <nav style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }} aria-label="Views">
          <button
            type="button"
            className={clsx('rail-btn', { 'rail-active': status === 'open' && !warmupView })}
            title="Inbox"
            onClick={() => {
              navigate('/inbox');
              setView({ status: 'open', unread: false, warmup: false });
            }}
          >
            <MessageSquare size={18} />
          </button>
          <button
            type="button"
            className={clsx('rail-btn', { 'rail-active': unreadOnly })}
            title={`Unread (${unreadTotal})`}
            style={{ position: 'relative' }}
            onClick={() => setView({ unread: !unreadOnly })}
          >
            <Bell size={18} />
            {unreadTotal > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  minWidth: 15,
                  height: 15,
                  borderRadius: 8,
                  background: 'var(--danger)',
                  color: '#fff',
                  fontSize: 10,
                  lineHeight: '15px',
                  paddingInline: 3,
                  fontWeight: 700,
                }}
              >
                {unreadTotal > 99 ? '99+' : unreadTotal}
              </span>
            )}
          </button>
          <button
            type="button"
            className={clsx('rail-btn', { 'rail-active': status === 'snoozed' && !warmupView })}
            title="Snoozed"
            onClick={() => setView({ status: 'snoozed' })}
          >
            <Clock size={18} />
          </button>
          <button
            type="button"
            className={clsx('rail-btn', { 'rail-active': status === 'archived' && !warmupView })}
            title="Archived"
            onClick={() => setView({ status: 'archived' })}
          >
            <Archive size={18} />
          </button>
          <button
            type="button"
            className="rail-btn"
            title="Analytics — coming with the next milestone"
            disabled
            style={{ opacity: 0.45 }}
          >
            <BarChart2 size={18} />
          </button>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="rail-btn"
              title="More"
              aria-haspopup="menu"
              aria-expanded={navMenuOpen}
              onClick={() => setNavMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={18} />
            </button>
            <Menu open={navMenuOpen} onClose={() => setNavMenuOpen(false)} align="left">
              <MenuItem onClick={() => navigate('/settings/mailboxes')}>Mailboxes</MenuItem>
              <MenuItem onClick={() => navigate('/settings/team')}>Settings</MenuItem>
              <MenuItem onClick={() => void signOut()}>
                Sign out ({bootstrap?.user.email ?? ''})
              </MenuItem>
            </Menu>
          </div>
        </nav>
        <label style={{ flex: '0 1 520px', position: 'relative' }}>
          <Search
            size={15}
            style={{ position: 'absolute', left: 12, top: 12, color: 'var(--muted-foreground)' }}
            aria-hidden
          />
          <input
            className="input"
            style={{ paddingLeft: 34, minHeight: 38 }}
            placeholder="Search Reply Dashboard"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
          <Link
            to="/settings/mailboxes"
            className="btn btn-ghost"
            style={{ minHeight: 34, fontSize: 13 }}
            title={primaryMailbox?.lastError ?? undefined}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background:
                  brokenCount > 0
                    ? 'var(--danger)'
                    : primaryMailbox
                      ? 'var(--primary)'
                      : 'var(--muted-foreground)',
              }}
              aria-hidden
            />
            {primaryMailbox
              ? `${primaryMailbox.provider === 'google' ? 'Google' : 'Microsoft'} · ${primaryMailbox.email}${
                  (mailboxes.data?.items.length ?? 0) > 1
                    ? ` +${(mailboxes.data?.items.length ?? 1) - 1}`
                    : ''
                }${brokenCount ? ` · ${brokenCount} sync issue${brokenCount > 1 ? 's' : ''}` : ''}`
              : 'No mailbox connected'}
          </Link>
        </div>
      </header>
      <div
        className={clsx('app-shell', { 'thread-open': Boolean(conversationId) })}
        style={{ gridTemplateColumns: 'minmax(300px, 380px) 1fr' }}
      >
        <div style={{ display: 'contents' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }} className="list-pane-wrap">
            <div
              style={{
                display: 'flex',
                gap: 6,
                padding: 10,
                borderBottom: '1px solid var(--border-soft)',
                background: 'var(--sidebar)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
                <button
                  type="button"
                  className={clsx('btn', hasActiveFilters ? 'btn-primary' : 'btn-secondary')}
                  style={{ minHeight: 36, width: '100%', justifyContent: 'space-between' }}
                  aria-haspopup="menu"
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <SlidersHorizontal size={14} />
                    Filters
                  </span>
                  <ChevronDown size={14} />
                </button>
                <Menu open={filtersOpen} onClose={() => setFiltersOpen(false)} align="left">
                  <div style={{ display: 'grid', gap: 8, padding: 6, minWidth: 230 }}>
                    <label style={{ display: 'grid', gap: 4, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)' }}>
                      Reply type
                      <select
                        className="input"
                        style={{ minHeight: 34, fontSize: 13.5, textTransform: 'none', letterSpacing: 'normal', color: 'var(--foreground)' }}
                        value={params.get('replyLabel') ?? ''}
                        onChange={(e) => {
                          const next = new URLSearchParams(params);
                          if (e.target.value) next.set('replyLabel', e.target.value);
                          else next.delete('replyLabel');
                          setParams(next);
                        }}
                      >
                        <option value="">All</option>
                        {(Object.keys(REPLY_LABELS) as ReplyLabel[]).map((label) => (
                          <option key={label} value={label}>
                            {REPLY_LABELS[label].text}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: 'grid', gap: 4, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-foreground)' }}>
                      Sending mailbox
                      <select
                        className="input"
                        style={{ minHeight: 34, fontSize: 13.5, textTransform: 'none', letterSpacing: 'normal', color: 'var(--foreground)' }}
                        value={mailboxId ?? ''}
                        onChange={(e) => {
                          const next = new URLSearchParams(params);
                          if (e.target.value) next.set('mailboxId', e.target.value);
                          else next.delete('mailboxId');
                          setParams(next);
                        }}
                      >
                        <option value="">All</option>
                        {(mailboxes.data?.items ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.email} ({m.unreadCount})
                          </option>
                        ))}
                      </select>
                    </label>
                    <MenuItem
                      onClick={() => {
                        const next = new URLSearchParams(params);
                        if (unreadOnly) next.delete('unread');
                        else next.set('unread', '1');
                        setParams(next);
                      }}
                    >
                      {unreadOnly ? '✓ ' : ''}Unread only
                    </MenuItem>
                  </div>
                </Menu>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ minHeight: 36 }}
                onClick={() => syncAll.mutate()}
                disabled={syncAll.isPending}
                aria-label="Sync mailboxes"
                title="Sync mailboxes"
              >
                <RefreshCw size={15} />
              </button>
              {hasActiveFilters && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ minHeight: 34, color: 'var(--danger)' }}
                  onClick={clearFilters}
                  aria-label="Clear all filters"
                >
                  <X size={14} />
                  Clear
                </button>
              )}
            </div>
            {warmupKeywordsActive && (
              <p
                style={{
                  margin: 0,
                  padding: '6px 12px',
                  fontSize: 12,
                  borderBottom: '1px solid var(--border-soft)',
                  color: '#a05a1c',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span>
                  Filtering warm-up noise (
                  <Link to="/settings/team" style={{ textDecoration: 'underline' }}>
                    manage keywords in Settings
                  </Link>
                  )
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    if (warmupView) next.delete('warmup');
                    else {
                      next.set('warmup', '1');
                      next.delete('status');
                    }
                    setParams(next);
                  }}
                  style={{ background: 'none', border: 0, padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
                >
                  {warmupView ? 'hide' : 'show'}
                </button>
              </p>
            )}
            <SyncBanner mailboxes={mailboxes.data?.items ?? []} />
            <ConversationList
              selectedId={conversationId}
              mailboxId={mailboxId}
              unreadOnly={unreadOnly}
              q={params.get('q') ?? ''}
              status={status}
              replyLabel={params.get('replyLabel') ?? undefined}
              warmup={warmupView}
              hasFilters={hasActiveFilters}
              onClearFilters={clearFilters}
            />
          </div>
          <ThreadPane conversationId={conversationId} />
        </div>
      </div>
    </div>
  );
}
