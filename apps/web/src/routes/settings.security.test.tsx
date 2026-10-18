import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AppConfig, AuthProvider } from '@unbent/shared';
import { Route } from './settings.security.js';
import { emailOtp, passkey, signIn, signOut } from '../auth-client.js';
import * as api from '../notes-api.js';
import type { TurnstileOptions } from '../turnstile.js';

// The route reads the instance's methods from `/api/config`; no network in a unit test.
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
}));

// The signed-in account, read to address the re-verification at the right person.
vi.mock('../auth-client.js', () => ({
  useSession: () => ({ data: { user: { email: 'someone@example.com' } }, isPending: false }),
  passkey: {
    listUserPasskeys: vi.fn().mockResolvedValue({ data: [] }),
    addPasskey: vi.fn(),
    deletePasskey: vi.fn().mockResolvedValue({}),
  },
  emailOtp: { sendVerificationOtp: vi.fn().mockResolvedValue({}) },
  signOut: vi.fn().mockResolvedValue({}),
  refreshSession: vi.fn().mockResolvedValue(null),
  signIn: {
    email: vi.fn().mockResolvedValue({}),
    emailOtp: vi.fn().mockResolvedValue({}),
    social: vi.fn().mockResolvedValue({}),
  },
}));

function harness(providers: AuthProvider[], config: Partial<AppConfig> = {}) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers, ...config });

  // Mount the real route component under a router, the way the app renders it.
  const rootRoute = createRootRoute({ component: Route.options.component });
  const history = createMemoryHistory({ initialEntries: ['/settings/security'] });
  const router = createRouter({ routeTree: rootRoute, history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

const notFresh = { data: null, error: { status: 403, statusText: 'Forbidden', message: 'Session is not fresh' } };
// The route only checks `result.error`; the success data shape is Better Auth's, not this
// test's concern, so a cast keeps the mocks readable without restating a whole Passkey.
const added = { data: {}, error: null } as unknown as Awaited<ReturnType<typeof passkey.addPasskey>>;

describe('SecurityPage passkey re-verification', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('adds a passkey directly when the session is fresh', async () => {
    vi.mocked(passkey.addPasskey).mockResolvedValue(added);
    harness(['email-otp', 'passkey']);

    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
    fireEvent.click(screen.getByText('Add a passkey'));

    await waitFor(() => expect(passkey.addPasskey).toHaveBeenCalled());
    // No re-verification: a fresh session goes straight through.
    expect(screen.queryByText('Email me a code')).toBeNull();
  });

  it('opens re-verification instead of surfacing the raw stale-session error', async () => {
    vi.mocked(passkey.addPasskey).mockResolvedValue(notFresh);
    harness(['email-otp', 'passkey']);

    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
    fireEvent.click(screen.getByText('Add a passkey'));

    // The freshness prompt, not "Session is not fresh".
    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
    expect(screen.queryByText('Session is not fresh')).toBeNull();
  });

  it('re-verifies by email code, then retries and completes the registration', async () => {
    // First attempt stale, second (after re-verifying) succeeds.
    vi.mocked(passkey.addPasskey)
      .mockResolvedValueOnce(notFresh)
      .mockResolvedValueOnce(added);
    harness(['email-otp', 'passkey']);

    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
    fireEvent.click(screen.getByText('Add a passkey'));

    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
    fireEvent.click(screen.getByText('Email me a code'));

    // The code is sent to the signed-in address, not one typed here.
    await waitFor(() =>
      expect(emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
        email: 'someone@example.com',
        type: 'sign-in',
      }),
    );

    const codeInput = await screen.findByLabelText('Code');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Confirm and add passkey'));

    await waitFor(() => expect(signIn.emailOtp).toHaveBeenCalledWith({ email: 'someone@example.com', otp: '123456' }));
    // The retry happens on its own once the session is fresh.
    await waitFor(() => expect(passkey.addPasskey).toHaveBeenCalledTimes(2));
    // Back to the normal control, panel gone.
    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
  });

  it('offers a password re-verification where the instance uses passwords', async () => {
    vi.mocked(passkey.addPasskey)
      .mockResolvedValueOnce(notFresh)
      .mockResolvedValueOnce(added);
    harness(['password', 'passkey']);

    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
    fireEvent.click(screen.getByText('Add a passkey'));

    const pw = await screen.findByLabelText('Password');
    fireEvent.change(pw, { target: { value: 'hunter2hunter2' } });
    fireEvent.click(screen.getByText('Confirm and add passkey'));

    await waitFor(() =>
      expect(signIn.email).toHaveBeenCalledWith({ email: 'someone@example.com', password: 'hunter2hunter2' }),
    );
    await waitFor(() => expect(passkey.addPasskey).toHaveBeenCalledTimes(2));
  });

  it('falls back to a social redirect where no method re-signs in place', async () => {
    vi.mocked(passkey.addPasskey).mockResolvedValue(notFresh);
    harness(['google', 'passkey']);

    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
    fireEvent.click(screen.getByText('Add a passkey'));

    const again = await screen.findByText('Continue with Google');
    fireEvent.click(again);
    await waitFor(() =>
      expect(signIn.social).toHaveBeenCalledWith({ provider: 'google', callbackURL: '/settings/security' }),
    );
  });

  /** A refused start used to leave the button saying "Redirecting…" for good. */
  it('shows a refused provider start rather than waiting on a redirect', async () => {
    vi.mocked(passkey.addPasskey).mockResolvedValue(notFresh);
    vi.mocked(signIn.social).mockResolvedValueOnce({
      error: { message: 'Verification failed', status: 403, statusText: 'Forbidden' },
    } as never);
    harness(['google', 'passkey']);

    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
    fireEvent.click(screen.getByText('Add a passkey'));
    fireEvent.click(await screen.findByText('Continue with Google'));

    await waitFor(() => expect(screen.getByText('Verification failed')).toBeTruthy());
    expect(screen.getByText('Continue with Google')).toBeTruthy();
  });

  /**
   * The server checks a token before a provider sign-in starts, and an instance with a
   * provider and no mail keeps the check, so the redirect here waits for one and carries it.
   */
  it('waits for a Turnstile token before the social redirect, and sends it', async () => {
    const widgets: TurnstileOptions[] = [];
    window.turnstile = {
      render: (_el, options) => {
        widgets.push(options);
        return String(widgets.length - 1);
      },
      reset: () => {},
      remove: () => {},
    };
    try {
      vi.mocked(passkey.addPasskey).mockResolvedValue(notFresh);
      harness(['google', 'passkey'], { turnstile: { siteKey: '1x00' } });

      await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
      fireEvent.click(screen.getByText('Add a passkey'));
      const google = () => screen.getByText('Continue with Google').closest('button') as HTMLButtonElement;
      await waitFor(() => expect(google()).toBeTruthy());
      await waitFor(() => expect(widgets).toHaveLength(1));
      expect(google().disabled).toBe(true);
      expect(google().getAttribute('aria-description')).toBe('Waiting for the check above to finish');

      act(() => widgets[0]!.callback('tok-1'));
      await waitFor(() => expect(google().disabled).toBe(false));
      fireEvent.click(google());
      await waitFor(() =>
        expect(signIn.social).toHaveBeenCalledWith({
          provider: 'google',
          callbackURL: '/settings/security',
          fetchOptions: { headers: { 'x-captcha-response': 'tok-1' } },
        }),
      );
    } finally {
      delete window.turnstile;
    }
  });

  /**
   * Inside the Android app the redirect would sign in a browser tab, not the app, so the
   * page offers the app's own sign-in instead: sign out, and the app's sign-in screen takes
   * over and brings back a session fresh enough to add the passkey.
   */
  it('offers the app\'s own sign-in instead of the redirect inside the app', async () => {
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    try {
      vi.mocked(passkey.addPasskey).mockResolvedValue(notFresh);
      harness(['google', 'passkey']);

      await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
      fireEvent.click(screen.getByText('Add a passkey'));

      fireEvent.click(await screen.findByText('Sign out'));
      await waitFor(() => expect(postMessage).toHaveBeenCalledWith('{"type":"signed-out"}'));
      expect(signOut).toHaveBeenCalled();
      expect(screen.queryByText('Continue with Google')).toBeNull();
      expect(signIn.social).not.toHaveBeenCalled();
    } finally {
      delete window.UnbentApp;
    }
  });

  it('still shows an unrelated failure as an error rather than a re-verify prompt', async () => {
    vi.mocked(passkey.addPasskey).mockResolvedValue({
      data: null,
      error: { status: 500, statusText: 'Server Error', message: 'Something broke' },
    });
    harness(['email-otp', 'passkey']);

    await waitFor(() => expect(screen.getByText('Add a passkey')).toBeTruthy());
    fireEvent.click(screen.getByText('Add a passkey'));

    await waitFor(() => expect(screen.getByText('Something broke')).toBeTruthy());
    expect(screen.queryByText('Email me a code')).toBeNull();
  });
});
