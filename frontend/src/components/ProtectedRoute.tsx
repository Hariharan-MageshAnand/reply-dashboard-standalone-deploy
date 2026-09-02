import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session';

export function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { loading, isAuthenticated, bootstrap } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <p className="muted">Restoring session…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (
    bootstrap?.needsOnboarding &&
    !location.pathname.startsWith('/onboarding') &&
    !location.pathname.startsWith('/settings')
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
