import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BootstrapResponse } from '@reply/contracts';
import { registerTokenGetter } from './api';
import { clearSessionToken, getSessionToken, setSessionToken } from './auth-token';
import { authApi } from './services';

export interface SessionContextValue {
  loading: boolean;
  bootstrap: BootstrapResponse | null;
  error: string | null;
  signIn: (email: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  isAuthenticated: boolean;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    registerTokenGetter(async () => getSessionToken());
  }, []);

  const refresh = useCallback(async () => {
    const token = getSessionToken();
    if (!token) {
      setBootstrap(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await authApi.bootstrap();
      setBootstrap(data);
      setError(null);
    } catch (err) {
      clearSessionToken();
      setBootstrap(null);
      setError(err instanceof Error ? err.message : 'Failed to bootstrap session');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({
      loading,
      bootstrap,
      error,
      isAuthenticated: Boolean(bootstrap),
      signIn: async (email: string, name?: string) => {
        const result = await authApi.login(email.trim().toLowerCase(), name);
        setSessionToken(result.token);
        setBootstrap(result.bootstrap);
        setError(null);
      },
      signOut: async () => {
        clearSessionToken();
        setBootstrap(null);
      },
      refresh,
    }),
    [loading, bootstrap, error, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
