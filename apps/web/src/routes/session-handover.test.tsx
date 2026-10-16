import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { ensureSession } from '../auth-client.js';
import { requireSession } from '../auth-gate.js';
import { claimCacheFor, keys } from '../queries.js';

// The gate's one dependency. Who is signed in, at any point below, is what this returns.
vi.mock('../auth-client.js', () => ({ ensureSession: vi.fn() }));

/** The rows an account holds, distinguishable by whose they are. */
const rowsOf = (id: string) => [`${id}'s tag`];

/**
 * The API, as far as this file needs one: it answers for whoever holds the cookie, and
 * refuses when nobody does. Counting its calls is how "served from cache" is observed.
 */
let account: string | null = null;
const listTags = vi.fn(async () => {
  if (!account) throw new Error('401 Unauthorized');
  return rowsOf(account);
});

/** Sign somebody in, or `null` for nobody: both ends of the session at once. */
function signedInAs(id: string | null) {
  account = id;
  vi.mocked(ensureSession).mockResolvedValue(
    id ? { user: { id, email: `${id}@example.com` } } : null,
  );
}

/** What each run of the protected route's loader was handed, in order. */
const served: string[][] = [];

/**
 * One tab, two people, no reload: the gate and the cache together.
 *
 * The rows a signed-in user loads outlive their session: signing out empties the session
 * store and moves the tab to `/login`, but every note, tag and count stays in the query
 * cache. That is invisible until somebody else signs in, because route loaders resolve
 * through `ensureQueryData` and an entry younger than `staleTime` is returned without the
 * server being asked, so the second person's `/notes` was served the first person's list.
 *
 * `claimCacheFor` runs in the root `beforeLoad`, which is the last moment before those
 * loaders start. The cases below are about what a loader receives, not what is rendered:
 * by the time the wrong rows are on screen the leak has already happened.
 *
 * The routes are rebuilt rather than imported from the generated tree, and the loader asks
 * for the real `keys.tags()` rather than `tagsQuery()`, so the test needs no API and no
 * components. The key is what has to match for the removal to reach it.
 */
function harness() {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    beforeLoad: async ({ location, context }) => {
      const session = await requireSession(location);
      claimCacheFor(context.queryClient, session?.user.id);
    },
    component: Outlet,
  });

  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <p>sign-in screen</p>,
  });

  /** A gated route, standing in for /notes, /trash, /settings and the rest. */
  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    loader: async ({ context: { queryClient } }) => {
      served.push(await queryClient.ensureQueryData({ queryKey: keys.tags(), queryFn: listTags }));
    },
    component: () => <p>note list</p>,
  });

  /**
   * `staleTime` is the app's own, because it is the mechanism under test: drop it to zero
   * and every one of these passes for the wrong reason, on a cache that refetches anyway.
   */
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, notesRoute]),
    history: createMemoryHistory({ initialEntries: ['/notes'] }),
    context: { queryClient },
    defaultPreloadStaleTime: 0,
  });

  render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );

  return { router, queryClient };
}

type Harness = ReturnType<typeof harness>;

/** Sign out to `/login`, the way the topbar does, and stop there. */
async function signOut(router: Harness['router']) {
  signedInAs(null);
  await router.navigate({ to: '/login', replace: true });
  await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
}

/** Sign in as `id` and go where the sign-in screen would send them. */
async function signIn(router: Harness['router'], id: string) {
  signedInAs(id);
  await router.navigate({ to: '/notes', replace: true });
  await waitFor(() => expect(served.length).toBeGreaterThan(1));
}

describe('a second person signing in to the same tab', () => {
  // The router restores scroll on navigation and jsdom has no window.scrollTo.
  beforeAll(() => {
    vi.stubGlobal('scrollTo', () => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    served.length = 0;
  });

  afterEach(cleanup);

  /**
   * The bug. Alice's tags are in the cache and younger than `staleTime` when Bob's loader
   * asks for them, so before the handover existed `ensureQueryData` answered out of the
   * cache and Bob's first paint was Alice's list.
   */
  it('is not served the previous session’s rows', async () => {
    signedInAs('alice');
    const { router } = harness();
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());
    expect(served).toEqual([rowsOf('alice')]);

    await signOut(router);
    await signIn(router, 'bob');

    expect(served[1]).toEqual(rowsOf('bob'));
    expect(served[1]).not.toEqual(rowsOf('alice'));
  });

  /** And the cache it leaves behind holds Bob's rows, not a mixture. */
  it('leaves nothing of the previous session in the cache', async () => {
    signedInAs('alice');
    const { router, queryClient } = harness();
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());

    await signOut(router);
    await signIn(router, 'bob');

    expect(queryClient.getQueryData(keys.tags())).toEqual(rowsOf('bob'));
  });

  /**
   * Why this is a targeted removal and not `queryClient.clear()`. The config query is the
   * instance's sign-in methods, held at `staleTime: Infinity` so that the login screen does
   * not flash its provider buttons in, and that screen is mounted, observing it, at the
   * moment Bob's navigation runs this. Clearing it puts the flash back.
   */
  it('keeps the sign-in screen’s own query', async () => {
    signedInAs('alice');
    const { router, queryClient } = harness();
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());
    queryClient.setQueryData(keys.config(), { providers: ['password'] });

    await signOut(router);
    await signIn(router, 'bob');

    expect(queryClient.getQueryData(keys.config())).toEqual({ providers: ['password'] });
  });

  /**
   * The rule is a change of user, not a sign-out, so somebody signing back into their own
   * account keeps their own cache. Being handed your own rows is not the leak, and
   * staleness already covers them (see `claimCacheFor` for why the seam is here at all).
   */
  it('keeps the cache when the same person signs back in', async () => {
    signedInAs('alice');
    const { router } = harness();
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());
    expect(listTags).toHaveBeenCalledTimes(1);

    await signOut(router);
    await signIn(router, 'alice');

    expect(served[1]).toEqual(rowsOf('alice'));
    expect(listTags).toHaveBeenCalledTimes(1);
  });
});
