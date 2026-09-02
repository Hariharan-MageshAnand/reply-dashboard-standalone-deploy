import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { MailboxProvider } from '@reply/contracts';
import { Sidebar } from '../components/Sidebar';
import { mailboxApi } from '../lib/services';
import { ApiClientError } from '../lib/api';

export function MailboxesPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [provider, setProvider] = useState<MailboxProvider>('google');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Surface the OAuth callback outcome the backend redirects back with.
  useEffect(() => {
    const cbError = params.get('error');
    const connected = params.get('connected');
    if (!cbError && !connected) return;
    if (cbError) setError(cbError);
    if (connected) setNotice('Mailbox connected — first sync is running.');
    const next = new URLSearchParams(params);
    next.delete('error');
    next.delete('connected');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: mailboxApi.list,
    refetchInterval: 10_000,
  });

  const connect = useMutation({
    mutationFn: async () => {
      const start = await mailboxApi.startConnect(provider, email || undefined);
      if (start.mock) {
        if (!email) throw new Error('Enter a mailbox email to connect in mock mode.');
        return mailboxApi.connectMock(email, provider);
      }
      if (start.authorizeUrl) {
        window.location.href = start.authorizeUrl;
      }
      return null;
    },
    onSuccess: async () => {
      setEmail('');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['mailboxes'] });
    },
    onError: (err) => {
      setError(
        err instanceof ApiClientError
          ? err.body.message
          : err instanceof Error
            ? err.message
            : 'Connect failed',
      );
    },
  });

  const sync = useMutation({
    mutationFn: (id: string) => mailboxApi.sync(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['mailboxes'] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => mailboxApi.disconnect(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['mailboxes'] });
    },
  });

  return (
    <div className="app-shell" style={{ gridTemplateColumns: '56px 1fr' }}>
      <Sidebar />
      <main style={{ padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <div>
            <h1 className="display-title" style={{ margin: 0, fontSize: 30 }}>
              Mailboxes
            </h1>
            <p className="muted" style={{ marginTop: 6 }}>
              Connect Google or Microsoft outreach accounts. Sync pulls threads; replies send from
              the mailbox that owns the conversation.
            </p>
          </div>
          <Link className="btn btn-secondary" to="/inbox">
            Open inbox
          </Link>
        </div>

        <div
          className="card"
          style={{ padding: 16, marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}
        >
          <select
            className="input"
            style={{ width: 160 }}
            value={provider}
            onChange={(e) => setProvider(e.target.value as MailboxProvider)}
            aria-label="Mailbox provider"
          >
            <option value="google">Google</option>
            <option value="microsoft">Microsoft</option>
          </select>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            type="email"
            placeholder="Optional — locks connect to this exact account"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending ? 'Connecting…' : `Connect ${provider === 'google' ? 'Google' : 'Microsoft'}`}
          </button>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, width: '100%' }}>
            Leave the email empty to connect whichever account you sign in with. If you fill it, it
            must exactly match the account you pick on the Google/Microsoft screen — otherwise the
            connect is rejected as a safety check.
          </p>
        </div>
        {error && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        {notice && (
          <p role="status" style={{ color: 'var(--primary)' }}>
            {notice}
          </p>
        )}

        <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
          {(mailboxes.data?.items ?? []).map((box) => (
            <article key={box.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <strong>{box.displayName || box.email}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {box.email}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <span className="badge">{box.provider}</span>
                    <span
                      className={`badge ${
                        box.health === 'healthy'
                          ? 'badge-ok'
                          : box.health === 'error' || box.health === 'auth_required'
                            ? 'badge-danger'
                            : 'badge-warn'
                      }`}
                    >
                      {box.health}
                    </span>
                    <span className="badge">{box.unreadCount} unread</span>
                    {box.capabilities.map((c) => (
                      <span key={c} className="badge">
                        {c}
                      </span>
                    ))}
                    {box.lastSyncedAt && (
                      <span className="badge">
                        synced {new Date(box.lastSyncedAt).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  {box.lastError && (
                    <p style={{ color: 'var(--danger)', marginBottom: 0, fontSize: 13 }}>
                      {box.lastError}
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => sync.mutate(box.id)}
                    disabled={sync.isPending}
                  >
                    Sync now
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      if (window.confirm(`Disconnect ${box.email}?`)) disconnect.mutate(box.id);
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            </article>
          ))}
          {(mailboxes.data?.items.length ?? 0) === 0 && (
            <p className="muted">No mailboxes connected yet.</p>
          )}
        </div>
      </main>
    </div>
  );
}
