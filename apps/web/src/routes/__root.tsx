import {
  createRootRouteWithContext,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
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
 * Two shells, chosen by where we are.
 *
 * Everything under `/embed/` is a page the Android app hosts inside a WebView, with its
 * own chrome around it: the app draws the title, the filing and the back button, and it
 * has already put a session cookie in place before loading the page. So that shell has
 * no topbar and no sign-in gate — an unauthenticated load is reported to the app through
 * the bridge rather than rendered as a login screen inside someone else's screen.
 *
 * Split into two components rather than branched inside one so the session hook runs
 * only where a session is the layout's business.
 */
function RootLayout() {
  const embedded = useRouterState({
    select: (s) => s.location.pathname.startsWith('/embed/'),
  });
  return embedded ? <EmbedShell /> : <AppShell />;
}

function EmbedShell() {
  return (
    <main className="shell embed">
      <Outlet />
    </main>
  );
}

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
function AppShell() {
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
