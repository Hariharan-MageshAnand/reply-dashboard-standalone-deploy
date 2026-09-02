import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MailboxProvider } from '@reply/contracts';
import { mailboxApi } from '../lib/services';
import { Sidebar } from '../components/Sidebar';
import { ApiClientError } from '../lib/api';
import { useSession } from '../lib/session';

export function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [provider, setProvider] = useState<MailboxProvider>('google');
  const [error, setError] = useState<string | null>(null);

  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: mailboxApi.list,
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
      await qc.invalidateQueries({ queryKey: ['mailboxes'] });
      await refresh();
      setError(null);
    },
    onError: (err) => {
      setError(
        err instanceof ApiClientError
          ? err.body.message
          : err instanceof Error
            ? err.message
            : 'Failed to connect mailbox',
      );
    },
  });

  const count = mailboxes.data?.items.length ?? 0;

  return (
    <div className="app-shell" style={{ gridTemplateColumns: '56px 1fr' }}>
      <Sidebar />
      <main style={{ padding: 32, maxWidth: 720 }}>
        <h1 className="display-title" style={{ fontSize: 32, marginTop: 0 }}>
          Connect your outreach mailboxes
        </h1>
        <p className="muted">
          Add the Google or Microsoft accounts you already use for cold outreach. Replies sync into
          one shared inbox.
        </p>

        <div className="card" style={{ padding: 20, marginTop: 20, display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Provider</span>
            <select
              className="input"
              value={provider}
              onChange={(e) => setProvider(e.target.value as MailboxProvider)}
            >
              <option value="google">Google</option>
              <option value="microsoft">Microsoft</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Mailbox email (optional)</span>
            <input
              className="input"
              type="email"
              placeholder="Optional — locks connect to this exact account"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="muted" style={{ fontSize: 12.5 }}>
              Leave empty to connect whichever account you sign in with. If filled, it must exactly
              match the account you pick on the Google/Microsoft screen.
            </span>
          </label>
          {error && (
            <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
              {error}
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={connect.isPending}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? 'Connecting…' : 'Connect mailbox'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={count === 0}
              onClick={async () => {
                await refresh();
                navigate('/inbox');
              }}
            >
              Continue to inbox ({count})
            </button>
          </div>
        </div>

        <ul style={{ listStyle: 'none', padding: 0, marginTop: 24, display: 'grid', gap: 8 }}>
          {(mailboxes.data?.items ?? []).map((box) => (
            <li key={box.id} className="card" style={{ padding: '12px 16px' }}>
              <strong>{box.email}</strong>
              <span className="badge" style={{ marginLeft: 8 }}>
                {box.provider}
              </span>
              <span
                className={`badge badge-${box.health === 'healthy' || box.health === 'syncing' ? 'ok' : 'warn'}`}
                style={{ marginLeft: 8 }}
              >
                {box.health}
              </span>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
