import type {
  BootstrapResponse,
  ConversationDetail,
  ConversationListResponse,
  LoginResponse,
  MailboxProvider,
  ReplyDraft,
  ReplyLabel,
  SenderMailbox,
  WorkspaceSummary,
} from '@reply/contracts';
import { apiFetch } from './api';

export const authApi = {
  login: (email: string, name?: string) =>
    apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, name }),
    }),
  bootstrap: () => apiFetch<BootstrapResponse>('/auth/bootstrap', { method: 'POST' }),
  me: () => apiFetch<BootstrapResponse>('/auth/me'),
  renameWorkspace: (name: string) =>
    apiFetch<WorkspaceSummary>('/auth/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  updateWarmupKeywords: (warmupKeywords: string[]) =>
    apiFetch<WorkspaceSummary>('/auth/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ warmupKeywords }),
    }),
  updateSlaMinutes: (slaMinutes: number) =>
    apiFetch<WorkspaceSummary>('/auth/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ slaMinutes }),
    }),
  updateSourcingLead: (sourcingLeadEmail: string | null) =>
    apiFetch<WorkspaceSummary>('/auth/workspace', {
      method: 'PATCH',
      body: JSON.stringify({ sourcingLeadEmail }),
    }),
};

export const mailboxApi = {
  list: () => apiFetch<{ items: SenderMailbox[] }>('/mailboxes'),
  startConnect: (provider: MailboxProvider, emailHint?: string) =>
    apiFetch<{
      mock: boolean;
      provider: MailboxProvider;
      state: string;
      authorizeUrl: string | null;
    }>('/mailboxes/connect/start', {
      method: 'POST',
      body: JSON.stringify({ provider, emailHint }),
    }),
  connectMock: (email: string, provider: MailboxProvider = 'google', displayName?: string) =>
    apiFetch<{ id: string; email: string; provider: MailboxProvider }>(
      '/mailboxes/connect/mock',
      {
        method: 'POST',
        body: JSON.stringify({ email, provider, displayName }),
      },
    ),
  sync: (mailboxId: string, full = false) =>
    apiFetch<{ queued: boolean }>(`/mailboxes/${mailboxId}/sync`, {
      method: 'POST',
      body: JSON.stringify(full ? { full: true } : {}),
    }),
  disconnect: (mailboxId: string) =>
    apiFetch<void>(`/mailboxes/${mailboxId}`, { method: 'DELETE' }),
};

export const conversationApi = {
  list: (params: Record<string, string | boolean | undefined>) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === '') return;
      qs.set(k, String(v));
    });
    const query = qs.toString();
    return apiFetch<ConversationListResponse>(`/conversations${query ? `?${query}` : ''}`);
  },
  get: (id: string) => apiFetch<ConversationDetail>(`/conversations/${id}`),
  markRead: (id: string, unread: boolean) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/read`, {
      method: 'POST',
      body: JSON.stringify({ unread }),
    }),
  setStatus: (id: string, status: string, snoozedUntil?: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify(snoozedUntil ? { status, snoozedUntil } : { status }),
    }),
  assign: (id: string, assigneeId: string | null) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ assigneeId }),
    }),
  setLabels: (id: string, labels: string[]) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/labels`, {
      method: 'PUT',
      body: JSON.stringify({ labels }),
    }),
  saveDraft: (id: string, bodyHtml: string, bodyText: string) =>
    apiFetch<ReplyDraft>(`/conversations/${id}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ bodyHtml, bodyText }),
    }),
  reply: (id: string, bodyHtml: string, bodyText: string, idempotencyKey: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ bodyHtml, bodyText, idempotencyKey }),
    }),
  scheduleSend: (id: string, bodyHtml: string, bodyText: string, scheduledFor: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/schedule-send`, {
      method: 'POST',
      body: JSON.stringify({ bodyHtml, bodyText, scheduledFor }),
    }),
  cancelScheduledSend: (id: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/schedule-send`, {
      method: 'DELETE',
    }),
  classify: (id: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/classify`, { method: 'POST' }),
  correctLabel: (id: string, label: ReplyLabel) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/label`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  generateDraft: (id: string, instruction?: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/generate-draft`, {
      method: 'POST',
      body: JSON.stringify(instruction ? { instruction } : {}),
    }),
  requestApproval: (id: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/request-approval`, { method: 'POST' }),
  overrideApproval: (id: string) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/approval-override`, { method: 'POST' }),
};
