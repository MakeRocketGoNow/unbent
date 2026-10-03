import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen.js';
import { installErrorReporting } from './report-error.js';
import { installPosthog } from './posthog.js';
import { installLaunchFiles } from './launch-files.js';
import { configQuery, installLibraryQueries } from './queries.js';
import { applyInstanceMarker } from './instance-marker.js';
import { registerServiceWorker } from './sw-register.js';
import { installConnectivity } from './connectivity.js';
import { installSessionRecheck } from './auth-client.js';
import { isOfflineError } from './notes-api.js';
import { onUploaded } from './store/actions.js';
import { indexUploadedFile } from './index-files.js';
import './styles.css';

/*
 * Before anything else renders, so that a crash while mounting the app is reported rather
 * than only shown. The editor runs in the Android app's WebView, where a JavaScript error
 * is invisible to Play's crash reporting — see `report-error.ts`.
 */
installErrorReporting();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Notes are edited in this tab and nowhere else, so refetching on every window
      // focus would be pure noise. Mutations invalidate what they affect instead.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      /*
       * Always make the first attempt, even when the browser says it is offline, because
       * the service worker may hold the answer (`sw/sw.ts`). React Query's default waits
       * for the connection instead — so the request never reached the worker, and a
       * route loader awaiting it waited with the page on its way in. Retries still pause
       * while offline and resume with the connection.
       */
      networkMode: 'offlineFirst',
      /*
       * Not a request that failed for want of a connection. Retries pause while offline,
       * so a read the worker had no copy of would sit "loading" until the connection came
       * back, and the page could never say it isn't available offline. It fails at once
       * instead, and the refetch on reconnect (`connectivity.ts`) asks again.
       */
      retry: (failureCount, error) => !isOfflineError(error) && failureCount < 3,
    },
    mutations: {
      // The same for writes: fail now, where the page can say so, rather than wait
      // silently and replay later a change the person has stopped expecting.
      networkMode: 'offlineFirst',
    },
  },
});

/*
 * Whether the server can be reached, for the banner, the editor and React Query's
 * pausing alike; see `connectivity.ts`. Before the first request, so the first failure is
 * heard.
 */
installConnectivity(queryClient);

/*
 * The local copy of the library drives the note queries; when it changes, they run
 * again. See `queries.ts`.
 */
installLibraryQueries(queryClient);
installSessionRecheck();

/*
 * A file added with no connection is uploaded from the outbox when there is one, by which
 * time the editor that took it may be long gone. Its text is read for search then, from
 * the bytes the queue still holds, exactly as an upload made online has its text read
 * where it was dropped (`indexUploadedFile` decides whether the server is doing it).
 */
onUploaded(indexUploadedFile);

/*
 * Error tracking, on the instances that have it — see `posthog.ts`.
 *
 * Here in module scope rather than in an effect, because `StrictMode` runs effects twice in
 * development and `posthog.init` is not something to call twice. Through the query client so
 * that the sign-in screen and Settings, which read the same config, get it from cache
 * instead of asking again.
 *
 * Nothing is buffered while this resolves, deliberately. An error thrown before it does has
 * already reached the Worker's log through the reporter installed above, which is the
 * destination every instance has; a buffer would be a second cap and a second set of rules
 * about what to drop, for reports that are not being lost.
 */
void queryClient
  .ensureQueryData(configQuery())
  .then((config) => {
    // Before the error tracker, which needs nothing from it: a scratch instance's tab
    // should say so as early as the page can know it is one.
    applyInstanceMarker(config);
    return config.posthog ? installPosthog(config.posthog) : undefined;
  })
  .catch(() => {});

const router = createRouter({
  routeTree,
  // Loaders resolve through this client, so route data and component data are the same
  // cache entry rather than two requests for the same rows.
  context: { queryClient },
  defaultPreload: 'intent',
  // React Query owns staleness; letting the router cache loader results too would mean
  // two caches to invalidate and one of them silently winning.
  defaultPreloadStaleTime: 0,
  /*
   * The boxes that scroll, so a new page starts at its top.
   *
   * The router resets the window on every navigation, but the window never scrolls here:
   * the signed-in shell is a viewport-height frame that clips, and each view scrolls a box
   * of its own inside it. Those boxes belong to layouts that stay mounted while their child
   * route changes — Settings around each of its pages, the note column around each note —
   * so they kept whatever offset the last page left. Editing the last notebook in a long
   * list opened its settings already scrolled away from the name, and opening a note from
   * the list landed as far down it as the previous note had been read.
   *
   * Registered here rather than reset by each layout on its own, because the router
   * already knows which navigations should keep their place: anything passing
   * `resetScroll: false`, as the notes view does when it only changes how the list is
   * drawn. A layout watching its own pathname would have to learn that distinction again.
   *
   * `querySelector`, so one element each; the split view's two panes are named apart. The
   * note list is left out on purpose: it is what a note is picked from, and has to stay
   * where it was when one is opened. Leaving a selector here that matches nothing on the
   * current page is harmless — the router skips it.
   */
  scrollToTopSelectors: ['.settings', '.workspace-main', '.editor-pane', '.preview-pane'],
});

/*
 * Files the operating system opened with the installed app; see `launch-files.ts`. After
 * the router exists, because the note that results is opened through it.
 */
installLaunchFiles(queryClient, (noteId) => {
  void router.navigate({ to: '/notes/$noteId', params: { noteId } });
});

/*
 * The service worker, which lets the installed app open with no connection, and the
 * hand-off to a new deploy; see `sw-register.ts`. After the router, so nothing it does
 * can delay the first render, and given the router's committed path so a deploy can be
 * taken on a change of page rather than a change of filter.
 */
registerServiceWorker(() => (router.state.resolvedLocation ?? router.state.location).pathname);

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
