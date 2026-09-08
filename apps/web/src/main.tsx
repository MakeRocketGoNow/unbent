import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen.js';
import { installErrorReporting } from './report-error.js';
import { installPosthog } from './posthog.js';
import { configQuery } from './queries.js';
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
    },
  },
});

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
  .then((config) => (config.posthog ? installPosthog(config.posthog) : undefined))
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
});

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
