import { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';

export function LoginPage({ mode = 'sign-in' }: { mode?: 'sign-in' | 'sign-up' }) {
  const { isAuthenticated, loading, signIn, error } = useSession();
  const [email, setEmail] = useState('hari@emsoft.com');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const navigate = useNavigate();

  const title = useMemo(
    () => (mode === 'sign-up' ? 'Create your workspace' : 'Welcome back'),
    [mode],
  );

  if (!loading && isAuthenticated) {
    return <Navigate to="/inbox" replace />;
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--background)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 440 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              margin: '0 auto 12px',
              background: 'radial-gradient(circle at 30% 30%, #6b9137, #163a24)',
            }}
            aria-hidden
          />
          <h1 className="display-title" style={{ margin: 0, fontSize: 30, color: '#163A24' }}>
            Reply
          </h1>
          <p style={{ margin: '8px 0 0', fontWeight: 600 }}>{title}</p>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
            Shared inbox for your outreach mailboxes.
          </p>
        </div>

        <div className="card" style={{ padding: 20 }}>
          <h2 className="display-title" style={{ marginTop: 0, textAlign: 'center', fontSize: 24 }}>
            {mode === 'sign-up' ? 'Get started' : 'Sign in'}
          </h2>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setSubmitting(true);
              setLocalError(null);
              try {
                await signIn(email.trim().toLowerCase(), name.trim() || undefined);
                navigate('/inbox');
              } catch (err) {
                setLocalError(err instanceof Error ? err.message : 'Sign-in failed');
              } finally {
                setSubmitting(false);
              }
            }}
            style={{ display: 'grid', gap: 12 }}
          >
            {mode === 'sign-up' && (
              <label>
                <span className="sr-only">Name</span>
                <input
                  className="input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </label>
            )}
            <label>
              <span className="sr-only">Email address</span>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                autoComplete="email"
              />
            </label>
            {(localError || error) && (
              <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 14 }}>
                {localError || error}
              </p>
            )}
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? 'Continuing…' : 'Continue'}
            </button>
            <p className="muted" style={{ fontSize: 12, margin: 0, textAlign: 'center' }}>
              Local email sign-in. Mailboxes connect separately via Google or Microsoft.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
