import { createRootRouteWithContext, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppSession } from '../useAppSession.js';
import { useSignOut } from '../useSignOut.js';
import { requireSession, useShell } from '../auth-gate.js';
import { Rail, RailHandle, useRailWidth, type RailPref } from '../components/Rail.js';
import { InstanceRibbon } from '../components/InstanceRibbon.js';
import { usePersistentState } from '../usePersistentState.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { handOver } from '../hand-over.js';
import { startIndexing, subscribeIndexing } from '../index-files.js';
import { Topbar } from '../components/Topbar.js';
import { OfflineBanner } from '../components/OfflineBanner.js';
import { PlanBanner } from '../components/PlanBanner.js';
import { LibraryStatus } from '../components/LibraryStatus.js';
import { useOffline } from '../connectivity.js';
import { useHostApp } from '../useHostApp.js';
import { postToApp } from '../app-bridge.js';
import { ExportSnackbar } from '../components/ExportSnackbar.js';
import { ImportSnackbar } from '../components/ImportSnackbar.js';
import { FileNotesSnackbar } from '../components/FileNotesSnackbar.js';
import { SignOutSnackbar } from '../components/SignOutSnackbar.js';
import { SignOutConfirm } from '../components/SignOutConfirm.js';
import { SyncingLine } from '../components/SyncingLine.js';
import { UpdateSnackbar } from '../components/UpdateSnackbar.js';
import { claimImportFor, getImportRun, subscribeImport } from '../import-run.js';
import { configQuery } from '../queries.js';
import { AgreementPending, LegalAgreement, agreementGate } from '../components/LegalAgreement.js';

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
   * What the tab holds for one person is handed over in the same breath, and for the same
   * timing reason: this is the last moment before the loaders run. See `handOver`.
   */
  beforeLoad: async ({ location, context }) => {
    const session = await requireSession(location);
    handOver(context.queryClient, session?.user.id);
  },
  component: RootLayout,
});

/**
 * Three shells, chosen by what is rendered — `useShell` decides, and the same answer
 * decides what the gate above lets through unauthenticated.
 *
 * `/embed/` is the page the Android app loads off screen to extract a PDF's text after a
 * capture (`/embed/index-files`). Nobody sees it, and the app has already put a session
 * cookie in place before loading it. So that shell has no chrome and no gate — an
 * unauthenticated load is reported to the app through the bridge rather than redirected
 * to a sign-in screen nobody would see — and no agreement to the terms either, which is
 * asked for on the screens a person does see.
 *
 * `plain` is the pages that exist because there is no session: the sign-in screen and the
 * far end of a password-reset mail. They are centred on an otherwise empty page, with no
 * topbar to sign out of.
 *
 * `front` is the bare root, which on the public instance is the front page for someone
 * signed out, and lays itself out.
 *
 * Split into separate components rather than branched inside one so the session hook runs
 * only where a session is the layout's business.
 */
function RootLayout() {
  const shell = useShell();
  if (shell === 'embed') return <EmbedShell />;
  if (shell === 'plain') return <PlainShell />;
  if (shell === 'front') return <FrontShell />;
  return <AppShell />;
}

function EmbedShell() {
  return (
    <main className="shell">
      <Outlet />
    </main>
  );
}

/**
 * Takes `children` for the one signed-in screen drawn in the same frame: the agreement to
 * the terms, which stands in for the app's routes rather than being one of them.
 */
function PlainShell({ children }: { children?: ReactNode }) {
  return (
    <main className="shell centered">
      <InstanceRibbon placement="page" />
      {children ?? <Outlet />}
    </main>
  );
}

/**
 * The front page draws its own header and footer, full width, so the shell adds nothing
 * but the instance's ribbon — the page is only ever shown on the dev instance, previews
 * and production, and the first two must still say which they are.
 */
function FrontShell() {
  return (
    <>
      <InstanceRibbon placement="page" />
      <Outlet />
    </>
  );
}

/**
 * The signed-in app: chrome, and the background work that only makes sense for a user.
 *
 * There is no gate here any more. The route guard has established a session before this
 * renders, so the session is read for two things: the address in the chrome, and
 * liveness — a session that expires, or a sign-out in another tab, arrives through this
 * hook and nowhere else, and has to move the user off a screen they can no longer load.
 * Through `useAppSession`, so a check that merely failed to reach the server — no signal —
 * is not mistaken for either.
 */
function AppShell() {
  const { session, isPending, unreachable } = useAppSession();
  const config = useQuery(configQuery());
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const offline = useOffline();
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
   *
   * Not while offline, when every file it asked for would fail: it waits for the
   * connection and starts then. The pass still runs at most once a session.
   */
  useEffect(() => {
    if (!userId) return;
    if (!offline) startIndexing({ auto: true });
    return subscribeIndexing((state) => {
      // A stopped pass indexed what it got through, which makes a cached search as stale.
      const ended = state.status === 'done' || state.status === 'stopped';
      if (ended && state.progress?.indexed) {
        void queryClient.invalidateQueries({ queryKey: ['search'] });
      }
    });
  }, [userId, offline, queryClient]);

  /**
   * The import run, which outlives the page it was started from.
   *
   * Claimed for this user, and for nobody when the session goes away under this shell —
   * expiry, or a sign-out in another tab. See `ImportRun.claim`; `useSignOut` drops it
   * for a sign-out made here, and the `beforeLoad` claim catches one neither saw.
   */
  useEffect(() => {
    claimImportFor(userId);
  }, [userId]);

  /**
   * An import creates notes, notebooks and tags, so nothing cached is still true once it
   * ends — however it ends, since a failed run has usually landed some notes first. Here
   * rather than on the import page because the run may end while that page is not
   * mounted.
   *
   * A separate effect from the claim, and not keyed on the user, so it is still listening
   * when a claim throws a running import away. That reset is an ending like any other —
   * notes landed before it, and the same person signing back in keeps their cache — and
   * an effect that resubscribed on the user's change would be torn down just before it.
   */
  useEffect(() => {
    let last = getImportRun().status;
    return subscribeImport(() => {
      const { status } = getImportRun();
      if (status === last) return;
      if (last === 'running') void queryClient.invalidateQueries();
      last = status;
    });
  }, [queryClient]);

  /**
   * The session going away under a rendered app — expiry, or a sign-out in another tab.
   * The guard cannot catch that: it runs on navigation, and this happens between them.
   */
  useEffect(() => {
    if (isPending || session?.user) return;
    // The library is closed by `recordSession` on the same answer; see `store/wipe.ts`.
    // The app, if there is one, takes over from here; see `requireSession`.
    postToApp({ type: 'unauthorized' });
    void navigate({ to: '/login', replace: true });
  }, [isPending, session, navigate]);

  const gate = session?.user
    ? agreementGate({ unreachable, config, agreed: session.user.legalVersion, pathname })
    : ({ kind: 'wait' } as const);
  if (!session?.user || gate.kind === 'wait') {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  // The agreement to the terms, in place of the app until it is given; see
  // `agreementGate` for when it is asked and `LegalAgreement` for why it is asked here.
  if (gate.kind === 'ask') {
    // The sign-out's question about unsynced writes and its failure notice are mounted
    // here too: Sign out is this screen's way out, and `useSignOut` hands both to these
    // components, so without them a press with writes waiting would do nothing at all.
    return (
      <PlainShell>
        <LegalAgreement legal={gate.legal} agreed={session.user.legalVersion} onSignOut={signOutAndLeave} />
        <SignOutSnackbar />
        <SignOutConfirm />
      </PlainShell>
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
      {/* The phone has no rail, and its drawer is closed most of the time, so the ribbon
          is pinned to the screen's corner instead; see `InstanceRibbon`. */}
      {isMobile && <InstanceRibbon placement="page" />}
      <main className="shell-main">
        {/* The phone's chrome, on the pages that have no heading of their own; the
            stylesheet hides it above the breakpoint, where the rail is the chrome. */}
        <Topbar email={session.user.email} onSignOut={signOutAndLeave} />
        <OfflineBanner />
        <PlanBanner />
        {gate.kind === 'open' && gate.pending && <AgreementPending />}
        <LibraryStatus />
        <SyncingLine />
        <Outlet />
      </main>
      <ExportSnackbar />
      <ImportSnackbar />
      <FileNotesSnackbar />
      <SignOutSnackbar />
      <SignOutConfirm />
      <UpdateSnackbar />
    </div>
  );
}
