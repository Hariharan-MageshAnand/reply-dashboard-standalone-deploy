import { NavLink } from 'react-router-dom';
import { Inbox, Mail, Settings, LogOut } from 'lucide-react';
import { useSession } from '../lib/session';
import clsx from 'clsx';

/** Icon rail (demo layout): 56px, icons only, tooltips via title. */
export function Sidebar({ collapsed: _collapsed = false }: { collapsed?: boolean }) {
  const { bootstrap, signOut } = useSession();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx('rail-btn', { 'rail-active': isActive });

  return (
    <aside className="sidebar-pane icon-rail" aria-label="Workspace navigation">
      <div
        className="rail-logo"
        title={bootstrap?.workspace.name ?? 'Reply'}
        aria-label={bootstrap?.workspace.name ?? 'Reply'}
      />
      <nav style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
        <NavLink to="/inbox" className={linkClass} title="Inbox">
          <Inbox size={19} aria-hidden />
          <span className="sr-only">Inbox</span>
        </NavLink>
        <NavLink to="/settings/mailboxes" className={linkClass} title="Mailboxes">
          <Mail size={19} aria-hidden />
          <span className="sr-only">Mailboxes</span>
        </NavLink>
        <NavLink to="/settings/team" className={linkClass} title="Settings">
          <Settings size={19} aria-hidden />
          <span className="sr-only">Settings</span>
        </NavLink>
      </nav>
      <div style={{ marginTop: 'auto', display: 'grid', justifyItems: 'center', gap: 4 }}>
        <button
          type="button"
          className="rail-btn"
          title={`Sign out (${bootstrap?.user.email ?? ''})`}
          onClick={() => void signOut()}
        >
          <LogOut size={17} aria-hidden />
          <span className="sr-only">Sign out</span>
        </button>
      </div>
    </aside>
  );
}
