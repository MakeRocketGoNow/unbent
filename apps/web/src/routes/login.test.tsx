import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { SIGNUPS_CLOSED_MESSAGE } from '@unbent/shared';
import { Route } from './login.js';
import * as api from '../notes-api.js';

// No network in a unit test: the screen draws from a config with one provider.
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
}));

// Nobody is signed in, so the route's `beforeLoad` lets the screen draw.
vi.mock('../auth-client.js', () => ({
  ensureSession: vi.fn().mockResolvedValue(null),
  signIn: { social: vi.fn(), email: vi.fn(), passkey: vi.fn().mockResolvedValue({}), emailOtp: vi.fn() },
  signUp: { email: vi.fn() },
  emailOtp: { sendVerificationOtp: vi.fn() },
  requestPasswordReset: vi.fn(),
  refreshSession: vi.fn().mockResolvedValue(null),
}));

/**
 * The real `/login` route, search schema and all, under a bare root. `Login.test.tsx`
 * hands the component its `refusal` directly; this is the half it cannot see — the route
 * reading `?error=` and taking it back out of the address.
 */
function harness(initial: string) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers: ['google'] });
  const rootRoute = createRootRoute();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const login = (Route as any).update({ getParentRoute: () => rootRoute, path: '/login', id: '/login' });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree: rootRoute.addChildren([login]), history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return router;
}

describe('/login', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /**
   * Left in the address, a reload or a Back press would show the refusal again as if it
   * had just happened. The destination has to survive the cleanup, or the retry signs in
   * to the wrong place.
   */
  it('shows a refusal from the URL, then drops the code and keeps the destination', async () => {
    const router = harness('/login?error=SIGNUPS_CLOSED&redirect=%2Fx');
    await waitFor(() => expect(screen.getByText(SIGNUPS_CLOSED_MESSAGE)).toBeTruthy());
    await waitFor(() => expect(router.state.location.search).toEqual({ redirect: '/x' }));
    expect(router.history.location.search).toBe('?redirect=%2Fx');
    // Replaced, not pushed: Back must not return to the address with the code in it.
    expect(router.history.length).toBe(1);
    // Still on screen after the address no longer carries it.
    expect(screen.getByText(SIGNUPS_CLOSED_MESSAGE)).toBeTruthy();
  });
});
