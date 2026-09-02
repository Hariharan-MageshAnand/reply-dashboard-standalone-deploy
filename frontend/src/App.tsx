import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from './lib/session';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { InboxPage } from './pages/InboxPage';
import { MailboxesPage } from './pages/MailboxesPage';
import { TeamSettingsPage } from './pages/TeamSettingsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
    },
  },
});

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage mode="sign-in" />} />
      <Route path="/sign-up" element={<LoginPage mode="sign-up" />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/inbox/:conversationId" element={<InboxPage />} />
        <Route path="/settings/mailboxes" element={<MailboxesPage />} />
        <Route path="/mailboxes" element={<Navigate to="/settings/mailboxes" replace />} />
        <Route path="/settings/team" element={<TeamSettingsPage />} />
      </Route>
      <Route path="/" element={<Navigate to="/inbox" replace />} />
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <AppRoutes />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
