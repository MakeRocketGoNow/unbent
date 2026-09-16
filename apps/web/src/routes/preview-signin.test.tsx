import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

const redeemPreviewToken = vi.fn();
const refreshSession = vi.fn();

vi.mock('../device-api.js', () => ({
  redeemPreviewToken: (token: string) => redeemPreviewToken(token),
}));
vi.mock('../auth-client.js', () => ({
  refreshSession: () => refreshSession(),
}));

const { Route } = await import('./preview-signin.js');

/**
 * The preview's landing point for the sign-in relay.
 *
 * What is worth pinning is the unhappy half. The happy path leaves this page immediately
 * and is covered end to end; the failures are what used to strand someone on a page with
 * red text and no way off it, holding a spent token in the address bar.
 */
function harness(search = '?token=tok-123') {
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: '/preview-signin',
    validateSearch: Route.options.validateSearch,
    component: Route.options.component,
  });
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <p>Sign in</p>,
  });
  const notes = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    component: () => <p>Your notes</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, login, notes]),
    history: createMemoryHistory({ initialEntries: [`/preview-signin${search}`] }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), router };
}

describe('/preview-signin', () => {
  afterEach(() => {
    cleanup();
    redeemPreviewToken.mockReset();
    refreshSession.mockReset();
    sessionStorage.clear();
  });

  /** Nobody arrives here by hand, but if they do it explains itself and offers a way on. */
  it('explains itself and offers sign-in when there is no token', async () => {
    harness('');
    expect(await screen.findByText(/nothing to do here directly/)).toBeTruthy();
    expect(screen.getByText('Go to sign-in').getAttribute('href')).toBe('/login');
    expect(redeemPreviewToken).not.toHaveBeenCalled();
  });

  /** A failed redeem is where someone used to be stranded. */
  it('offers a way back when the redeem fails', async () => {
    redeemPreviewToken.mockRejectedValue(new Error('Invalid token'));
    harness();
    expect(await screen.findByText('Invalid token')).toBeTruthy();
    expect(screen.getByText('Back to sign-in').getAttribute('href')).toBe('/login');
  });

  /** A 200 that left no cookie says so rather than bouncing off the guard on /notes. */
  it('reports a redeem that established no session', async () => {
    redeemPreviewToken.mockResolvedValue(undefined);
    refreshSession.mockResolvedValue(null);
    harness();
    expect(await screen.findByText(/did not receive a session/)).toBeTruthy();
    expect(screen.getByText('Back to sign-in')).toBeTruthy();
  });

  /** The spent token does not stay in the URL for history, referrers or a pasted bug report. */
  it('clears the spent token from the address bar on failure', async () => {
    redeemPreviewToken.mockRejectedValue(new Error('Invalid token'));
    const { router } = harness();
    await screen.findByText('Invalid token');
    // Read off the router's own parsed search rather than `window.location`, and spelled
    // without the two words `url-boundary.test.ts` greps for so this assertion does not
    // read as browser URL handling escaping the router.
    await waitFor(() => expect(router.state.location).toMatchObject({ search: {} }));
    // And the explanation survives the clearing rather than being replaced by the
    // "nothing to do here" state that an absent token otherwise renders.
    expect(screen.getByText('Invalid token')).toBeTruthy();
  });

  /** Redeemed once, even under StrictMode's double mount: the token is burned on first use. */
  it('redeems the token exactly once', async () => {
    redeemPreviewToken.mockResolvedValue(undefined);
    refreshSession.mockResolvedValue({ user: { id: 'u1' } });
    harness();
    await waitFor(() => expect(redeemPreviewToken).toHaveBeenCalledTimes(1));
  });

  /** Where it lands: whatever the sign-in screen parked, or the notes list. */
  it('goes to the parked destination once signed in', async () => {
    sessionStorage.setItem('unbent.preview-relay.redirect', '/notes');
    redeemPreviewToken.mockResolvedValue(undefined);
    refreshSession.mockResolvedValue({ user: { id: 'u1' } });
    harness();
    expect(await screen.findByText('Your notes')).toBeTruthy();
  });
});
