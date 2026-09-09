import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ConversationDetail, ConversationListItem } from '@reply/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionContextValue } from '../lib/session';
import { conversationApi, mailboxApi } from '../lib/services';
import { InboxPage } from './InboxPage';

vi.mock('../lib/services', () => ({
  conversationApi: {
    list: vi.fn(),
    get: vi.fn(),
    setStatus: vi.fn(),
    markRead: vi.fn(),
    salesforce: vi.fn(),
  },
  mailboxApi: {
    list: vi.fn(),
  },
}));

const session: SessionContextValue = {
  loading: false,
  bootstrap: {
    user: {
      id: 'u1',
      authKey: 'ak',
      email: 'op@example.com',
      firstName: 'Op',
      lastName: 'Erator',
      fullName: 'Op Erator',
      profilePhotoUrl: null,
    },
    workspace: {
      id: 'w1',
      name: 'Emergence',
      slug: 'emergence',
      role: 'owner',
      warmupKeywords: [],
      slaMinutes: 60,
      sourcingLeadEmail: null,
    },
    needsOnboarding: false,
  },
  error: null,
  isAuthenticated: true,
  signIn: async () => {},
  signOut: async () => {},
  refresh: async () => {},
};

function listItem(id: string, subject: string, fromName: string): ConversationListItem {
  return {
    id,
    mailboxId: 'mb1',
    mailboxEmail: 'outreach@example.com',
    subject,
    snippet: `${subject} snippet`,
    participants: [{ email: `${id}@acme.test`, name: fromName, role: 'from' }],
    unread: false,
    status: 'archived',
    replyStatus: 'awaiting_reply',
    snoozedUntil: null,
    scheduledFor: null,
    label: null,
    redirectName: null,
    isWarmup: false,
    sfMatched: null,
    sfMatchType: null,
    slaBreachedAt: null,
    labels: [],
    assigneeId: null,
    assigneeName: null,
    lastMessageAt: '2026-09-01T12:00:00.000Z',
    outreachCampaign: null,
    messageCount: 2,
  };
}

function detailOf(item: ConversationListItem, status: ConversationListItem['status']): ConversationDetail {
  return {
    ...item,
    status,
    messages: [
      {
        id: `${item.id}-m1`,
        gmailMessageId: `${item.id}-g1`,
        direction: 'inbound',
        from: item.participants[0],
        to: [{ email: 'outreach@example.com', name: null, role: 'to' }],
        cc: [],
        subject: item.subject,
        bodyHtml: null,
        bodyText: 'Hello',
        sentAt: item.lastMessageAt,
        attachments: [],
      },
    ],
    draft: null,
    sendState: { status: 'idle', errorMessage: null, updatedAt: null },
    scheduledSend: null,
    classification: null,
    latestAiDraft: null,
    approval: null,
  };
}

const acme = listItem('c-acme', 'Acme partnership', 'Acme Corp');
const beta = listItem('c-beta', 'Beta follow-up', 'Beta Inc');

describe('Unarchive from Archived view', () => {
  const opened = new Set<string>();

  beforeEach(() => {
    opened.clear();
    vi.mocked(mailboxApi.list).mockResolvedValue({ items: [] });
    vi.mocked(conversationApi.salesforce).mockResolvedValue({
      ready: false,
      match: null,
      sequence: null,
      account: null,
      opportunities: [],
      matchedBy: null,
      related: [],
    });
    vi.mocked(conversationApi.markRead).mockImplementation(async (id) =>
      detailOf(id === acme.id ? acme : beta, opened.has(id) ? 'open' : 'archived'),
    );
    vi.mocked(conversationApi.list).mockImplementation(async (params) => {
      const items = [acme, beta].filter((item) => {
        const status = opened.has(item.id) ? 'open' : item.status;
        if (params.status) return status === params.status;
        return status === 'open';
      });
      return { items, nextCursor: null, totalUnread: 0 };
    });
    vi.mocked(conversationApi.get).mockImplementation(async (id) => {
      const item = id === acme.id ? acme : beta;
      return detailOf(item, opened.has(id) ? 'open' : 'archived');
    });
    vi.mocked(conversationApi.setStatus).mockImplementation(async (id, status) => {
      if (status === 'open') opened.add(id);
      const item = id === acme.id ? acme : beta;
      return detailOf(item, status === 'open' ? 'open' : 'archived');
    });
  });

  it('drops the unarchived row from the Archived list without navigating away', async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    const router = createMemoryRouter(
      [
        { path: '/inbox', element: <InboxPage /> },
        { path: '/inbox/:conversationId', element: <InboxPage /> },
      ],
      { initialEntries: ['/inbox/c-acme?status=archived'] },
    );

    render(
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session}>
          <RouterProvider router={router} />
        </SessionContext.Provider>
      </QueryClientProvider>,
    );

    const list = await screen.findByLabelText('Conversations');
    await within(list).findByText('Acme partnership');
    expect(within(list).getByText('Beta follow-up')).toBeTruthy();

    const listFetchesBefore = vi.mocked(conversationApi.list).mock.calls.length;
    const unarchive = await screen.findByRole('button', { name: 'Unarchive conversation' });
    unarchive.click();

    await waitFor(() => {
      expect(within(screen.getByLabelText('Conversations')).queryByText('Acme partnership')).toBeNull();
    });

    expect(conversationApi.setStatus).toHaveBeenCalledWith('c-acme', 'open');
    expect(within(screen.getByLabelText('Conversations')).getByText('Beta follow-up')).toBeTruthy();
    expect(screen.getByLabelText('Conversation thread')).toBeTruthy();
    expect(within(screen.getByLabelText('Conversation thread')).getByText(/Acme partnership/)).toBeTruthy();
    expect(router.state.location.pathname).toBe('/inbox/c-acme');
    expect(router.state.location.search).toBe('?status=archived');
    // List refresh is driven by the unarchive success handler, not the 15s poll.
    expect(vi.mocked(conversationApi.list).mock.calls.length).toBeGreaterThan(listFetchesBefore);
  });
});
