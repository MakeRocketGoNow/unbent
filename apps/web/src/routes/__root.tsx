import { createRootRouteWithContext, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from '../auth-client.js';
import { useSignOut } from '../useSignOut.js';
import { requireSession, useShell } from '../auth-gate.js';
import { Rail, RailHandle, useRailWidth, type RailPref } from '../components/Rail.js';
import { usePersistentState } from '../usePersistentState.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { claimCacheFor } from '../queries.js';
import { startIndexing, subscribeIndexing } from '../index-files.js';
import { Topbar } from '../components/Topbar.js';
import { useHostApp } from '../useHostApp.js';
import { postToApp } from '../app-bridge.js';
import { ExportSnackbar } from '../components/ExportSnackbar.js';
import { claimImportFor, getImportRun, subscribeImport } from '../import-run.js';

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
   *
   * The cache is handed over in the same breath, and for the same timing reason. Loaders
   * resolve through `ensureQueryData`, so a second person signing in without reloading was
   * served the first one's notes out of the cache; this is the last moment before those
   * loaders run. See `claimCacheFor` for why it is keyed on the user rather than hung off
   * signing out.
   */
  beforeLoad: async ({ location, context }) => {
    const session = await requireSession(location);
    claimCacheFor(context.queryClient, session?.user.id);
  },
  component: RootLayout,
});

/**
 * Three shells, chosen by what is rendered — `useShell` decides, and the same answer
 * decides what the gate above lets through unauthenticated.
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
  const shell = useShell();
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
 * renders, so `useSession` is read for two things: the address in the chrome, and
 * liveness — a session that expires, or a sign-out in another tab, arrives through this
 * hook and nowhere else, and has to move the user off a screen they can no longer load.
 */
function AppShell() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const signOutAndLeave = useSignOut();
  const queryClient = useQueryClient();
  const userId = session?.user?.id;
  /*
   * The rail's state lives here, with the shell that carries the class the stylesheet
   * reads, rather than in the rail: storage hooks do not sync between instances, and the
   * class has to change with the button.
   */
  const [railPref, setRailPref] = usePersistentState<RailPref>('rail', 'auto', (raw) =>
    raw === 'open' || raw === 'collapsed' ? raw : undefined,
  );
  /*
   * The rail is mounted only above the breakpoint, the way the drawer is mounted only
   * below it (see `NotesLayout`): the two are one set of rows, and exactly one of them
   * should exist. One of the few places the breakpoint is read in JS, and the editor is
   * not in this subtree, so nothing it must not rebuild is rebuilt.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const railWidth = useRailWidth();
  const shellRef = useRef<HTMLDivElement>(null);
  // Back, a notification's note and the colour around the page, when the Android app
  // hosts the site; nothing in a browser.
  useHostApp();

  /**
   * Index whatever is pending, once there is someone to index for.
   *
   * The safety net under the server's read, not the main way a PDF gets its text. A
   * deployed instance extracts every uploaded PDF itself, but only once, at upload, and
   * nothing on the server tries again: a conversion that fails or runs out of time, a file
   * over its 25MB limit, or an instance without Workers AI (local development, a
   * self-hoster) leaves the file unsearchable. This catches those the next time the app
   * opens. It was written when the browser was the only extractor, which is why it is
   * a client pass at all.
   *
   * Cheap to ask on every open: the server answers from an index of the PDFs still
   * unread (0024), so when nothing is pending, which is nearly always, it reads nothing.
   * The pass declines a backlog larger than one page — see AUTO_INDEX_LIMIT — so this can
   * never start pulling gigabytes because a tab was opened on a phone; the sidebar says
   * what it left and Maintenance is where that gets run.
   *
   * Attachment text is what search reads, so a result cached before the pass ran is
   * stale once it has indexed something. Nothing else in the cache is.
   */
  useEffect(() => {
    if (!userId) return;
    startIndexing({ auto: true });
    return subscribeIndexing((state) => {
      // A stopped pass indexed what it got through, which makes a cached search as stale;
      // an image the server read is text in the same index as a PDF's.
      const ended = state.status === 'done' || state.status === 'stopped';
      if (ended && (state.progress?.indexed || state.images?.read)) {
        void queryClient.invalidateQueries({ queryKey: ['search'] });
      }
    });
  }, [userId, queryClient]);

  /**
   * The import run, which outlives the page it was started from.
   *
   * An import creates notes, notebooks and tags, so nothing cached is still true once it
   * ends — however it ends, since a failed run has usually landed some notes first. Here
   * rather than on the import page because the run may end while that page is not
   * mounted. Claimed for this user first; see `ImportRun.claim`.
   */
  useEffect(() => {
    if (!userId) return;
    claimImportFor(userId);
    let last = getImportRun().status;
    return subscribeImport(() => {
      const { status } = getImportRun();
      if (status === last) return;
      if (last === 'running') void queryClient.invalidateQueries();
      last = status;
    });
  }, [userId, queryClient]);

  /**
   * The session going away under a rendered app — expiry, or a sign-out in another tab.
   * The guard cannot catch that: it runs on navigation, and this happens between them.
   */
  useEffect(() => {
    if (isPending || session?.user) return;
    // The app, if there is one, takes over from here; see `requireSession`.
    postToApp({ type: 'unauthorized' });
    void navigate({ to: '/login', replace: true });
  }, [isPending, session, navigate]);

  if (!session?.user) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  /*
   * The shell is a row and the routed content is one column of it, so that navigation can
   * stand beside the content rather than above it. `<main>` is the column, not the row:
   * a landmark should hold the page's content and nothing that is chrome for every page.
   */
  return (
    <div className={`shell wide rail-${railPref}`} style={railWidth.style} ref={shellRef}>
      {/* The chain sign-out runs, and why its order matters, is in `useSignOut`. */}
      {!isMobile && (
        <>
          <Rail
            pref={railPref}
            onPref={setRailPref}
            email={session.user.email}
            onSignOut={signOutAndLeave}
          />
          <RailHandle
            containerRef={shellRef}
            width={railWidth}
            onCollapse={() => setRailPref('collapsed')}
          />
        </>
      )}
      <main className="shell-main">
        {/* The phone's chrome, on the pages that have no heading of their own; the
            stylesheet hides it above the breakpoint, where the rail is the chrome. */}
        <Topbar email={session.user.email} onSignOut={signOutAndLeave} />
        <Outlet />
      </main>
      <ExportSnackbar />
    </div>
  );
}
