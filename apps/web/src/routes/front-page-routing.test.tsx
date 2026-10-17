import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

const ensureSession = vi.fn();
const getConfig = vi.fn();

vi.mock('../auth-client.js', () => ({ ensureSession: () => ensureSession() }));
vi.mock('../notes-api.js', () => ({ getConfig: () => getConfig() }));

const { Route } = await import('./index.js');
const { Route: PricingRoute } = await import('./pricing.js');

/**
 * Where the bare root sends people, which is the whole of what decides whether a fork
 * advertises unbent.app's prices.
 *
 * The route's real `beforeLoad` against a real router; the page itself is a stand-in, so
 * the test reads only which of the three screens was reached.
 */
function harness(at = '/') {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()();
  const front = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    // Typed against the app's own root route, which this stand-in root is not.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeLoad: Route.options.beforeLoad as any,
    component: () => <p>Front page</p>,
  });
  const pricing = createRoute({
    getParentRoute: () => rootRoute,
    path: '/pricing',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeLoad: PricingRoute.options.beforeLoad as any,
    component: () => <p>Pricing</p>,
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
    routeTree: rootRoute.addChildren([front, pricing, login, notes]),
    history: createMemoryHistory({ initialEntries: [at] }),
    context: { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<RouterProvider router={router as any} />);
  return router;
}

describe('/', () => {
  afterEach(() => {
    cleanup();
    ensureSession.mockReset();
    getConfig.mockReset();
  });

  it('takes someone signed in to their notes, without asking about the instance', async () => {
    ensureSession.mockResolvedValue({ user: { id: 'u1' } });
    harness();
    expect(await screen.findByText('Your notes')).toBeTruthy();
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('shows the front page to someone signed out on the public instance', async () => {
    ensureSession.mockResolvedValue(null);
    getConfig.mockResolvedValue({ providers: [], frontPage: true });
    harness();
    expect(await screen.findByText('Front page')).toBeTruthy();
  });

  /** The fork deployed unchanged: no flag, so the sign-in screen it always had. */
  it('sends someone signed out to sign in on any other instance', async () => {
    ensureSession.mockResolvedValue(null);
    getConfig.mockResolvedValue({ providers: ['password'] });
    harness();
    expect(await screen.findByText('Sign in')).toBeTruthy();
  });

  /** The sign-in screen is the page every instance has; a failed config is not a reason to show prices. */
  it('falls back to sign-in when the config cannot be read', async () => {
    ensureSession.mockResolvedValue(null);
    getConfig.mockRejectedValue(new Error('offline'));
    harness();
    expect(await screen.findByText('Sign in')).toBeTruthy();
  });

  /**
   * The pricing address Paddle's review follows: the front page at its prices, under its
   * own address, and shown to anyone. Only the instance rule carries over from the bare
   * root, so a fork advertises nothing here either.
   */
  it('shows /pricing to someone signed out on the public instance', async () => {
    ensureSession.mockResolvedValue(null);
    getConfig.mockResolvedValue({ providers: [], frontPage: true });
    const router = harness('/pricing');
    expect(await screen.findByText('Pricing')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/pricing');
  });

  /** Unlike the bare root: a signed-in person asked for a page and gets it, not their notes. */
  it('shows /pricing to someone signed in too', async () => {
    ensureSession.mockResolvedValue({ user: { id: 'u1' } });
    getConfig.mockResolvedValue({ providers: [], frontPage: true });
    harness('/pricing');
    expect(await screen.findByText('Pricing')).toBeTruthy();
  });

  it('sends /pricing to sign in on an instance with no front page', async () => {
    ensureSession.mockResolvedValue(null);
    getConfig.mockResolvedValue({ providers: ['password'] });
    harness('/pricing');
    expect(await screen.findByText('Sign in')).toBeTruthy();
  });
});
