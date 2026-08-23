import { createRootRouteWithContext, Outlet, useNavigate } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { useSession, signOut } from '../auth-client.js';
import { Login } from '../components/Login.js';
import { Topbar } from '../components/Topbar.js';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

/**
 * Session gate and app chrome.
 *
 * The gate is here rather than in a `beforeLoad` guard because the session comes from
 * better-auth's `useSession` hook, which is React state — a loader would have to
 * duplicate that state into router context and keep the two in sync. Rendering the login
 * screen in place of the outlet keeps one source of truth, and it preserves the current
 * behaviour that a deep link opened while signed out stays in the address bar: signing in
 * then lands on the note that was asked for, with no redirect parameter to carry.
 */
function RootLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  if (isPending) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="shell centered">
        <Login />
      </main>
    );
  }

  return (
    <main className="shell wide">
      <Topbar
        email={session.user.email}
        onSignOut={() => {
          // Leaving a note id in the address bar would expose it to the next person and
          // reapply it on the next sign-in, so the URL is reset as part of signing out.
          void signOut().then(() => navigate({ to: '/notes', replace: true }));
        }}
      />
      <Outlet />
    </main>
  );
}
