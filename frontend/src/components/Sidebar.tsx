import { NavLink } from 'react-router-dom';
import { LogOut, Mail, MessageSquare, Settings } from 'lucide-react';
import { useSession } from '../lib/session';
import clsx from 'clsx';

/**
 * Labeled app sidebar. "Reply Dashboard" is one tab — the app is becoming a
 * hub (Salesforce next), so sections get named tabs instead of a bare icon
 * rail.
 */
export function Sidebar() {
  const { bootstrap, signOut } = useSession();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx('side-tab', { 'side-tab-active': isActive });

  return (
    <aside className="sidebar-pane side-nav" aria-label="Workspace navigation">
      <div className="side-brand" title={bootstrap?.workspace.name ?? 'Emergence'}>
        <span className="side-brand-dot" aria-hidden />
        <span className="side-brand-name">{bootstrap?.workspace.name ?? 'Emergence'}</span>
      </div>
      <nav style={{ display: 'grid', gap: 2 }}>
        <NavLink to="/inbox" className={linkClass}>
          <MessageSquare size={16} aria-hidden />
          Reply Dashboard
        </NavLink>
        <NavLink to="/settings/mailboxes" className={linkClass}>
          <Mail size={16} aria-hidden />
          Mailboxes
        </NavLink>
        <NavLink to="/settings/team" className={linkClass}>
          <Settings size={16} aria-hidden />
          Settings
        </NavLink>
      </nav>
      <div style={{ marginTop: 'auto', display: 'grid', gap: 4 }}>
        <button
          type="button"
          className="side-tab"
          title={bootstrap?.user.email ?? ''}
          onClick={() => void signOut()}
        >
          <LogOut size={15} aria-hidden />
          Sign out
        </button>
      </div>
    </aside>
  );
}
