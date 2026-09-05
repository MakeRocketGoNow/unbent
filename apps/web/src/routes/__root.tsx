import {
  createRootRouteWithContext,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession, signOut, refreshSession } from '../auth-client.js';
import { requireSession, shellFor } from '../auth-gate.js';
import { startIndexing, subscribeIndexing } from '../index-files.js';
import { Topbar } from '../components/Topbar.js';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  /**
   * The session gate, in front of every loader in the app.
   *
   * It is here rather than on each route because a route added without it would be a
   * silent hole, and here rather than in the component below because a component renders
   * after the loaders it wraps have already run. See `auth-gate.ts` for what that cost.
   */
  beforeLoad: ({ location }) => requireSession(location),
  component: RootLayout,
});

/**
 * Three shells, chosen by where we are — `shellFor` decides, and the same answer decides
 * what the gate above lets through unauthenticated.
 *
 * `/embed/` is a page the Android app hosts inside a WebView, with its own chrome around
 * it: the app draws the title, the filing and the back button, and it has already put a
 * session cookie in place before loading the page. So that shell has no topbar and no
 * gate — an unauthenticated load is reported to the app through the bridge rather than
 * redirected to a sign-in screen inside someone else's screen.
 *
 * `plain` is the pages that exist because there is no session: the sign-in screen and the
 * far end of a password-reset mail. They are centred on an otherwise empty page, with no
 * topbar to sign out of.
 *
 * Split into separate components rather than branched inside one so the session hook runs
 * only where a session is the layout's business.
 */
function RootLayout() {
  const shell = useRouterState({ select: (s) => shellFor(s.location.pathname) });
  if (shell === 'embed') return <EmbedShell />;
  if (shell === 'plain') return <PlainShell />;
  return <AppShell />;
}

function EmbedShell() {
  return (
    <main className="shell embed">
      <Outlet />
    </main>
  );
}

function PlainShell() {
  return (
    <main className="shell centered">
      <Outlet />
    </main>
  );
}

/**
 * The signed-in app: chrome, and the background work that only makes sense for a user.
 *
 * There is no gate here any more. The route guard has established a session before this
 * renders, so `useSession` is read for two things: the address in the topbar, and
 * liveness — a session that expires, or a sign-out in another tab, arrives through this
 * hook and nowhere else, and has to move the user off a screen they can no longer load.
 */
function AppShell() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = session?.user?.id;

  /**
   * Index whatever is pending, once there is someone to index for.
   *
   * The editor and the phone both upload PDFs without extracting their text, and the
   * button in Settings was the only thing that ever caught up. Now the app does on open.
   * The pass declines a backlog larger than one page — see AUTO_INDEX_LIMIT — so this can
   * never start pulling gigabytes because a tab was opened on a phone; the sidebar says
   * what it left and the Import panel is where that gets run.
   *
   * Attachment text is what search reads, so a result cached before the pass ran is
   * stale once it has indexed something. Nothing else in the cache is.
   */
  useEffect(() => {
    if (!userId) return;
    startIndexing({ auto: true });
    return subscribeIndexing((state) => {
      if (state.status === 'done' && state.progress?.indexed) {
        void queryClient.invalidateQueries({ queryKey: ['search'] });
      }
    });
  }, [userId, queryClient]);

  /**
   * The session going away under a rendered app — expiry, or a sign-out in another tab.
   * The guard cannot catch that: it runs on navigation, and this happens between them.
   */
  useEffect(() => {
    if (isPending || session?.user) return;
    void navigate({ to: '/login', replace: true });
  }, [isPending, session, navigate]);

  if (!session?.user) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="shell wide">
      <Topbar
        email={session.user.email}
        onSignOut={() => {
          /**
           * Leaving a note id in the address bar would expose it to the next person and
           * reapply it on the next sign-in, so signing out goes to `/login` rather than
           * staying put and letting the gate bounce it there a moment later.
           *
           * The session is refetched before navigating rather than left to settle on its
           * own: `/login` turns away anyone who is signed in, and it reads the same store
           * this call is in the middle of emptying.
           */
          void signOut()
            .then(() => refreshSession())
            .then(() => navigate({ to: '/login', replace: true }));
        }}
      />
      <Outlet />
    </main>
  );
}
