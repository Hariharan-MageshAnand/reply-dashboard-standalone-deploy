import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Sidebar } from '../components/Sidebar';
import { useSession } from '../lib/session';
import { authApi } from '../lib/services';
import { ApiClientError } from '../lib/api';

export function TeamSettingsPage() {
  const { bootstrap } = useSession();
  const [keywordsText, setKeywordsText] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slaMinutes, setSlaMinutes] = useState(60);
  const [slaSaved, setSlaSaved] = useState(false);
  const [leadEmail, setLeadEmail] = useState('');
  const [leadSaved, setLeadSaved] = useState(false);

  useEffect(() => {
    if (bootstrap?.workspace.warmupKeywords) {
      setKeywordsText(bootstrap.workspace.warmupKeywords.join('\n'));
    }
    if (bootstrap?.workspace.slaMinutes) {
      setSlaMinutes(bootstrap.workspace.slaMinutes);
    }
    setLeadEmail(bootstrap?.workspace.sourcingLeadEmail ?? '');
  }, [bootstrap?.workspace.id]);

  const saveLead = useMutation({
    mutationFn: async () => authApi.updateSourcingLead(leadEmail.trim() || null),
    onSuccess: (workspace) => {
      setLeadEmail(workspace.sourcingLeadEmail ?? '');
      setLeadSaved(true);
    },
  });

  const saveSla = useMutation({
    mutationFn: async () => authApi.updateSlaMinutes(slaMinutes),
    onSuccess: (workspace) => {
      setSlaMinutes(workspace.slaMinutes);
      setSlaSaved(true);
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const keywords = keywordsText
        .split('\n')
        .map((k) => k.trim())
        .filter(Boolean);
      return authApi.updateWarmupKeywords(keywords);
    },
    onSuccess: (workspace) => {
      setError(null);
      setKeywordsText(workspace.warmupKeywords.join('\n'));
      setSaved(
        workspace.warmupKeywords.length
          ? `Saved ${workspace.warmupKeywords.length} keyword(s) — applied to existing threads too.`
          : 'Keywords cleared — all threads visible again.',
      );
    },
    onError: (err) => {
      setSaved(null);
      setError(err instanceof ApiClientError ? err.body.message : 'Failed to save keywords');
    },
  });

  return (
    <div className="app-shell" style={{ gridTemplateColumns: '56px 1fr' }}>
      <Sidebar />
      <main style={{ padding: 28, maxWidth: 720 }}>
        <h1 className="display-title" style={{ marginTop: 0, fontSize: 30 }}>
          Settings
        </h1>

        <div className="card" style={{ padding: 20, display: 'grid', gap: 10 }}>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>
              Workspace
            </div>
            <strong>{bootstrap?.workspace.name}</strong>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>
              Signed in as
            </div>
            <strong>{bootstrap?.user.email}</strong>
          </div>
        </div>

        <div className="card" style={{ padding: 20, marginTop: 16, display: 'grid', gap: 10 }}>
          <div>
            <strong>Sourcing Lead sign-off</strong>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13.5 }}>
              Approval-request emails go here. The Lead approves or requests changes with one-click
              links — no login needed. Leave empty to disable the sign-off flow.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <input
              className="input"
              type="email"
              style={{ minWidth: 260 }}
              placeholder="lead@company.com"
              value={leadEmail}
              onChange={(e) => {
                setLeadEmail(e.target.value);
                setLeadSaved(false);
              }}
              aria-label="Sourcing Lead email"
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={saveLead.isPending}
              onClick={() => saveLead.mutate()}
            >
              {saveLead.isPending ? 'Saving…' : 'Save'}
            </button>
            {leadSaved && (
              <span className="muted" style={{ fontSize: 13 }}>
                Saved.
              </span>
            )}
          </div>
        </div>

        <div className="card" style={{ padding: 20, marginTop: 16, display: 'grid', gap: 10 }}>
          <div>
            <strong>Response SLA</strong>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13.5 }}>
              Minutes a reply may wait unanswered before it gets a visible “SLA breach” tag. The
              tag clears automatically when a response goes out.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              className="input"
              type="number"
              min={5}
              max={1440}
              style={{ width: 120 }}
              value={slaMinutes}
              onChange={(e) => {
                setSlaMinutes(Number(e.target.value));
                setSlaSaved(false);
              }}
              aria-label="SLA threshold in minutes"
            />
            <span className="muted" style={{ fontSize: 13 }}>
              minutes
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saveSla.isPending || slaMinutes < 5 || slaMinutes > 1440}
              onClick={() => saveSla.mutate()}
            >
              {saveSla.isPending ? 'Saving…' : 'Save SLA'}
            </button>
            {slaSaved && (
              <span className="muted" style={{ fontSize: 13 }}>
                Saved.
              </span>
            )}
          </div>
        </div>

        <div className="card" style={{ padding: 20, marginTop: 16, display: 'grid', gap: 10 }}>
          <div>
            <strong>Warm-up noise filtering</strong>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13.5 }}>
              Threads whose subject or body contains any keyword below are flagged as warm-up/test
              noise: hidden from the inbox (visible via the Warm-up filter) and skipped by the AI
              classifier. One keyword per line, case-insensitive. Saving re-applies to existing
              threads in both directions.
            </p>
          </div>
          <textarea
            className="textarea"
            rows={6}
            placeholder={'warmup\nwarm-up\ntest sequence'}
            value={keywordsText}
            onChange={(e) => {
              setKeywordsText(e.target.value);
              setSaved(null);
            }}
            aria-label="Warm-up keywords, one per line"
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save keywords'}
            </button>
            {saved && (
              <span className="muted" style={{ fontSize: 13 }}>
                {saved}
              </span>
            )}
            {error && (
              <span role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>
                {error}
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
