import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AuthProvider } from '@unbent/shared';
import { Login, returnTo } from './Login.js';
import * as api from '../notes-api.js';

// No network in a unit test: the config is what each case says it is.
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
}));

// The auth client would otherwise reach for the real endpoints on module load.
vi.mock('../auth-client.js', () => ({
  signIn: { social: vi.fn(), email: vi.fn() },
  signUp: { email: vi.fn() },
}));

/**
 * Where sign-in sends you afterwards.
 *
 * Both halves have been wrong in production. Returning always to `/notes` dropped the
 * device code and left the CLI waiting on a page the user could not get back to; returning
 * to the current URL unconditionally then parked people on a one-time approval page, which
 * shows an expiry error on the next visit and reads as sign-in being broken.
 */
describe('returnTo', () => {
  it('keeps a device code, so an approval survives signing in', () => {
    expect(returnTo('/device?user_code=ABCD1234')).toBe('/device?user_code=ABCD1234');
  });

  it('sends a bare /device to the notes, since there is nothing to approve', () => {
    expect(returnTo('/device')).toBe('/notes');
  });

  it('treats an empty user_code as no code', () => {
    expect(returnTo('/device?user_code=')).toBe('/notes');
  });

  it('keeps ordinary deep links intact', () => {
    expect(returnTo('/notes/abc-123')).toBe('/notes/abc-123');
    expect(returnTo('/trash')).toBe('/trash');
  });

  it('keeps query strings on ordinary pages', () => {
    expect(returnTo('/notes?tag=recipes')).toBe('/notes?tag=recipes');
  });

  it('leaves the root alone', () => {
    expect(returnTo('/')).toBe('/');
  });
});

/**
 * The screen is drawn from `/api/config`, not from a list in the component.
 *
 * The cases are the three instances that exist in practice: unbent.app with providers
 * only, a self-hosted instance with a password only, and one that offers both.
 */
function harness(providers: AuthProvider[]) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers });

  const rootRoute = createRootRoute({ component: Login });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('Login', () => {
  beforeAll(() => {
    vi.stubGlobal('scrollTo', () => {});
  });

  afterEach(cleanup);

  it('shows one button per provider and no form when only providers are offered', async () => {
    harness(['google', 'github']);
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());
    expect(screen.getByText('Continue with GitHub')).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('shows the form and no provider buttons for a password-only instance', async () => {
    harness(['password']);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByText('Continue with Google')).toBeNull();
    // Nothing to separate from, so no divider.
    expect(screen.queryByText('or')).toBeNull();
  });

  it('separates the two with a divider when both are offered', async () => {
    harness(['github', 'password']);
    await waitFor(() => expect(screen.getByText('or')).toBeTruthy());
    expect(screen.getByText('Continue with GitHub')).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('says so when an instance offers nothing at all', async () => {
    harness([]);
    await waitFor(() =>
      expect(screen.getByText('This Unbent has no sign-in method configured.')).toBeTruthy(),
    );
  });
});
