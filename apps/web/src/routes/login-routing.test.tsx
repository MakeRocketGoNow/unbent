import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';
import { ensureSession } from '../auth-client.js';
import { HOME, requireSession, safeRedirect } from '../auth-gate.js';

// The gate's one dependency. Each case below says who is signed in by what this returns.
vi.mock('../auth-client.js', () => ({ ensureSession: vi.fn() }));

const SESSION = { user: { id: 'u1', email: 'a@example.com' } };

/** Stands in for every request a protected route's loader makes. */
const load = vi.fn();

/**
 * The gate, against a real router.
 *
 * The thing worth pinning is a timing one, and invisible by reading: `beforeLoad` finishes
 * for the whole matched chain before any loader starts, which is the only reason
 * redirecting an unauthenticated visit stops that route's requests from being made. When
 * the gate was a component instead, `/notes` fired four requests with no cookie, each
 * 401'd into a route nobody could see, and the first successful sign-in swapped the login
 * screen for that route's error boundary — "Something went wrong! 401 Unauthorized" —
 * which only a reload cleared. `load` not being called is that bug.
 *
 * The routes are rebuilt rather than imported from the generated tree so the test needs no
 * API and no components; the gate and the search-param rules are the real ones.
 */
function harness(initial: string) {
  const rootRoute = createRootRoute({
    beforeLoad: ({ location }) => requireSession(location),
    component: Outlet,
  });

  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: z.object({
      redirect: z.string().max(2048).optional().catch(undefined).transform(safeRedirect),
    }),
    beforeLoad: async ({ search }) => {
      if (await ensureSession()) throw redirect({ href: search.redirect ?? HOME, replace: true });
    },
    component: () => <p>sign-in screen</p>,
  });

  /** A gated route, standing in for /notes, /trash, /settings and the rest. */
  const guarded = (path: string, text: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      loader: () => load(path),
      component: () => <p>{text}</p>,
    });

  const routeTree = rootRoute.addChildren([
    loginRoute,
    guarded('/notes', 'note list'),
    guarded('/notes/$noteId', 'one note'),
    guarded('/trash', 'trash'),
    guarded('/device', 'device approval'),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/reset-password',
      component: () => <p>choose a new password</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/embed/notes/$noteId',
      loader: () => load('/embed/notes/$noteId'),
      component: () => <p>embedded note</p>,
    }),
  ]);

  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree, history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );

  return router;
}

/**
 * The whole URL, percent-decoding included, which is how these cases read best: the point
 * of most of them is what the sign-in screen was told to come back to.
 *
 * Through `href` rather than the router's parsed search params, because the boundary in
 * `url-boundary.test.ts` greps for the browser's URL properties by name to keep navigation
 * the router's business, and the router spells its own the same way.
 */
function url(router: { state: { location: { href: string } } }): string {
  return decodeURIComponent(router.state.location.href);
}

const signedOut = () => vi.mocked(ensureSession).mockResolvedValue(null);
const signedIn = () => vi.mocked(ensureSession).mockResolvedValue(SESSION);

describe('the session gate', () => {
  // The router restores scroll on navigation and jsdom has no window.scrollTo.
  beforeAll(() => {
    vi.stubGlobal('scrollTo', () => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('sends a signed-out visitor to the sign-in screen instead of the page', async () => {
    signedOut();
    const router = harness('/notes');
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
    expect(router.state.location.pathname).toBe('/login');
  });

  /**
   * The bug. Before the gate moved into `beforeLoad`, this loader ran, 401'd, and left an
   * error boundary waiting behind the login screen for the moment somebody signed in.
   */
  it('runs none of the page’s requests while there is nobody to make them for', async () => {
    signedOut();
    harness('/notes');
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
    expect(load).not.toHaveBeenCalled();
  });

  it('makes the requests once there is a session', async () => {
    signedIn();
    harness('/notes');
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());
    expect(load).toHaveBeenCalledWith('/notes');
  });

  it('keeps the page that was asked for, so a deep link survives signing in', async () => {
    signedOut();
    const router = harness('/notes/abc-123');
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
    expect(url(router)).toBe('/login?redirect=/notes/abc-123');
  });

  /** A device code has to survive the round trip, or the CLI waits on a page nobody has. */
  it('keeps a device code through the sign-in screen', async () => {
    signedOut();
    const router = harness('/device?user_code=ABCD1234');
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
    expect(url(router)).toBe('/login?redirect=/device?user_code=ABCD1234');
  });

  /** Nothing to approve without a code, and a stale one reads as sign-in being broken. */
  it('does not send a bare /device back to itself', async () => {
    signedOut();
    const router = harness('/device');
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
    expect(url(router)).toBe('/login');
  });

  /** The ordinary case gets a plain URL rather than one carrying its own default. */
  it('names no destination when the destination is where sign-in goes anyway', async () => {
    signedOut();
    const router = harness('/notes');
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
    expect(url(router)).toBe('/login');
  });

  /**
   * The reset page is for people who cannot sign in. Gating it made the link in the mail
   * open a sign-in screen — the one thing its reader has already established they cannot use.
   */
  it('lets the password reset page render without a session', async () => {
    signedOut();
    harness('/reset-password?token=abc');
    await waitFor(() => expect(screen.getByText('choose a new password')).toBeTruthy());
  });

  /**
   * The Android app puts a cookie in place before loading the WebView and draws its own
   * chrome around it. A sign-in screen inside that is nobody's idea of a note.
   */
  it('leaves the app’s embedded pages alone', async () => {
    signedOut();
    const router = harness('/embed/notes/abc-123');
    await waitFor(() => expect(screen.getByText('embedded note')).toBeTruthy());
    expect(router.state.location.pathname).toBe('/embed/notes/abc-123');
    expect(load).toHaveBeenCalledWith('/embed/notes/$noteId');
  });

  /**
   * Without `replace` the sign-in screen sits on top of the page that bounced to it, and
   * Back re-enters the redirect: the user presses it, arrives, is bounced forward again,
   * and cannot leave.
   */
  it('replaces the page it bounced from, so Back is not a trap', async () => {
    signedOut();
    const router = harness('/reset-password');
    await waitFor(() => expect(screen.getByText('choose a new password')).toBeTruthy());

    await router.navigate({ to: '/notes' });
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());

    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/reset-password'));
  });
});

describe('the sign-in screen with a session already', () => {
  beforeAll(() => {
    vi.stubGlobal('scrollTo', () => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  /** A stale link, a bookmark, or a second tab that signed in first. */
  it('goes to the page that was asked for', async () => {
    signedIn();
    const router = harness('/login?redirect=%2Ftrash');
    await waitFor(() => expect(screen.getByText('trash')).toBeTruthy());
    expect(router.state.location.pathname).toBe('/trash');
  });

  it('goes to the notes when the URL names nowhere', async () => {
    signedIn();
    const router = harness('/login');
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());
    expect(router.state.location.pathname).toBe(HOME);
  });

  /**
   * Anything can write that parameter — a link in a mail, a page on another site — and it
   * is followed the moment a session exists. See `safeRedirect` for the rest of the rules.
   */
  it('will not be sent to another origin', async () => {
    signedIn();
    const router = harness('/login?redirect=https%3A%2F%2Fevil.example%2Fsteal');
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());
    expect(router.state.location.pathname).toBe(HOME);
  });
});
