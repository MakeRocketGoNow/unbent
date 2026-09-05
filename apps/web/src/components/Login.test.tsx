import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AuthProvider } from '@unbent/shared';
import { Login } from './Login.js';
import { emailOtp, signIn } from '../auth-client.js';
import * as api from '../notes-api.js';

// No network in a unit test: the config is what each case says it is.
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
}));

// The auth client would otherwise reach for the real endpoints on module load.
// `signIn.passkey` resolves to nothing: the conditional-UI call on mount is fire-and-forget,
// and a rejection there must stay invisible, which one of the cases below asserts.
vi.mock('../auth-client.js', () => ({
  signIn: {
    social: vi.fn(),
    email: vi.fn(),
    passkey: vi.fn().mockResolvedValue({}),
    emailOtp: vi.fn().mockResolvedValue({}),
  },
  signUp: { email: vi.fn() },
  emailOtp: { sendVerificationOtp: vi.fn().mockResolvedValue({}) },
  requestPasswordReset: vi.fn().mockResolvedValue({}),
  // Every sign-in that stays in the tab refetches the session before navigating; with no
  // server here it just has to resolve.
  refreshSession: vi.fn().mockResolvedValue(null),
}));

/**
 * The screen is drawn from `/api/config`, not from a list in the component.
 *
 * The cases are the three instances that exist in practice: unbent.app with providers
 * only, a self-hosted instance with a password only, and one that offers both.
 */
function harness(providers: AuthProvider[]) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers });

  // `redirectTo` is the route's job in the app; here it only has to be somewhere.
  const rootRoute = createRootRoute({ component: () => <Login redirectTo="/notes" /> });
  const history = createMemoryHistory({ initialEntries: ['/login'] });
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

  afterEach(() => {
    cleanup();
    // `cleanup` unmounts but leaves call history, and several cases below assert on
    // whether the autofill call was made at all.
    vi.clearAllMocks();
  });

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

  /**
   * Passkeys are their own button and their own kind of thing: not a redirect to somebody
   * else's site, and not a form. The mistake worth guarding against is the one this screen
   * already made once with Google — offering a method the instance never said it had.
   */
  it('offers a passkey button when the instance reports passkeys', async () => {
    harness(['passkey', 'password']);
    await waitFor(() => expect(screen.getByText('Sign in with a passkey')).toBeTruthy());
  });

  it('offers no passkey button when the instance does not report them', async () => {
    harness(['github']);
    await waitFor(() => expect(screen.getByText('Continue with GitHub')).toBeTruthy());
    expect(screen.queryByText('Sign in with a passkey')).toBeNull();
  });

  it('asks the browser to offer a passkey from autofill, without being pressed', async () => {
    harness(['passkey', 'password']);
    await waitFor(() => expect(signIn.passkey).toHaveBeenCalledWith({ autoFill: true }));
  });

  it('does not ask for autofill on an instance without passkeys', async () => {
    harness(['password']);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());
    expect(signIn.passkey).not.toHaveBeenCalled();
  });

  /**
   * A browser with no passkey support rejects the conditional-UI call immediately. That is
   * the ordinary case on a desktop with no authenticator, not a fault, and it must not put
   * an error over a screen where every other way in still works.
   */
  it('stays quiet when the browser refuses the autofill offer', async () => {
    vi.mocked(signIn.passkey).mockRejectedValueOnce(new Error('not supported'));
    harness(['passkey', 'password']);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());
    expect(screen.queryByText('not supported')).toBeNull();
  });

  /**
   * The reset acknowledgement is deliberately vague. Confirming that an address does have
   * an account would make this box a way to ask whether any given person uses Unbent.
   */
  /**
   * The code path is what lets unbent.app drop GitHub without becoming Google-only, so
   * the thing worth pinning down is that it appears exactly when the instance says it can
   * send mail — an instance that cannot would show a form that silently goes nowhere.
   */
  it('offers the code form when the instance can send mail', async () => {
    harness(['email-otp']);
    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
  });

  it('offers no code form when the instance cannot send mail', async () => {
    harness(['google']);
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());
    expect(screen.queryByText('Email me a code')).toBeNull();
  });

  it('asks for the code only after the address has been sent one', async () => {
    harness(['email-otp']);
    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
    // Nothing to type a code into yet: asking for both at once would invite typing a code
    // that has not been sent.
    expect(screen.queryByLabelText('Code')).toBeNull();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.click(screen.getByText('Email me a code'));

    await waitFor(() => expect(screen.getByLabelText('Code')).toBeTruthy());
    expect(emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: 'a@example.com',
      type: 'sign-in',
    });
  });

  /** A mistyped address is the common case, and it must be fixable without a reload. */
  it('goes back to the address when the code was sent to the wrong one', async () => {
    harness(['email-otp']);
    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'typo@example.com' } });
    fireEvent.click(screen.getByText('Email me a code'));

    await waitFor(() => expect(screen.getByLabelText('Code')).toBeTruthy());
    fireEvent.click(screen.getByText('Use a different address'));

    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
    expect(screen.queryByLabelText('Code')).toBeNull();
  });

  /** Digits only, so a pasted code with stray characters still submits. */
  it('keeps only digits in the code field', async () => {
    harness(['email-otp']);
    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.click(screen.getByText('Email me a code'));

    await waitFor(() => expect(screen.getByLabelText('Code')).toBeTruthy());
    const field = screen.getByLabelText('Code') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '12-34 56' } });
    expect(field.value).toBe('123456');
  });

  /**
   * The point of the server reporting plain strings: an instance can enable any of Better
   * Auth's providers by setting its credentials, and the screen has to draw a working
   * button for one this file has never named.
   */
  it('renders a provider it has never heard of', async () => {
    harness(['discord']);
    await waitFor(() => expect(screen.getByText('Continue with Discord')).toBeTruthy());
  });

  it('spells the awkward names properly', async () => {
    harness(['github', 'gitlab', 'linkedin']);
    await waitFor(() => expect(screen.getByText('Continue with GitHub')).toBeTruthy());
    expect(screen.getByText('Continue with GitLab')).toBeTruthy();
    expect(screen.getByText('Continue with LinkedIn')).toBeTruthy();
  });

  /**
   * Order is a deliberate choice, not an accident of which block was written first: a
   * social button is one tap and needs nothing typed, while a passkey only helps someone
   * who already has one — nobody, on a first visit.
   */
  it('puts social providers above everything else', async () => {
    harness(['google', 'passkey', 'email-otp']);
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());

    const order = [...document.querySelectorAll('button, label')]
      .map((el) => el.textContent ?? '')
      .filter((t) => /Google|passkey|Email/.test(t));

    expect(order[0]).toContain('Google');
  });

  /** One divider between each pair of methods, and none above the first or below the last. */
  it('divides the methods it shows, and only between them', async () => {
    harness(['google', 'passkey', 'email-otp']);
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());
    expect(document.querySelectorAll('.login-or').length).toBe(2);
  });

  it('shows no divider when only one method is offered', async () => {
    harness(['google']);
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());
    expect(document.querySelectorAll('.login-or').length).toBe(0);
  });

  /**
   * A mark where there is one, and no placeholder where there is not. An instance can
   * enable any of thirty-five providers and most have no icon here, so the button has to
   * read correctly without one.
   */
  it('draws a mark for a provider it has art for', async () => {
    harness(['github']);
    await waitFor(() => expect(screen.getByText('Continue with GitHub')).toBeTruthy());
    expect(document.querySelectorAll('.provider-icon').length).toBe(1);
  });

  it('draws no mark, and no placeholder, for one it does not', async () => {
    harness(['railway']);
    await waitFor(() => expect(screen.getByText('Continue with Railway')).toBeTruthy());
    expect(document.querySelectorAll('.provider-icon').length).toBe(0);
  });

  /** Google's mark keeps its four colours; its guidelines do not allow a flattened one. */
  it('keeps Google in its own colours', async () => {
    harness(['google']);
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());
    const paths = document.querySelectorAll('.provider-icon path');
    expect(paths.length).toBe(4);
    expect([...paths].every((p) => p.getAttribute('fill')?.startsWith('#'))).toBe(true);
  });

  /** The label already names the provider; the mark must not be announced a second time. */
  it('hides the mark from screen readers', async () => {
    harness(['github']);
    await waitFor(() => expect(screen.getByText('Continue with GitHub')).toBeTruthy());
    expect(document.querySelector('.provider-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * The bug this merge fixes: the two email methods were separate forms rendered one after
   * the other, so an instance offering both asked for the same address twice, a divider
   * apart, with nothing saying they were the same question.
   */
  it('asks for the address once when both email methods are offered', async () => {
    harness(['email-otp', 'password']);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeTruthy());
    expect(screen.getAllByLabelText('Email').length).toBe(1);
  });

  it('offers both ways forward from that one address', async () => {
    harness(['email-otp', 'password']);
    await waitFor(() => expect(screen.getByText('Sign in')).toBeTruthy());
    expect(screen.getByText('Email me a code')).toBeTruthy();
  });

  it('puts no divider between them, being one method by then', async () => {
    harness(['email-otp', 'password']);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeTruthy());
    expect(document.querySelectorAll('.login-or').length).toBe(0);
  });

  /** Each alone must look exactly as it did before the merge. */
  it('shows no password box for a codes-only instance', async () => {
    harness(['email-otp']);
    await waitFor(() => expect(screen.getByText('Email me a code')).toBeTruthy());
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('shows no code button for a password-only instance', async () => {
    harness(['password']);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeTruthy());
    expect(screen.queryByText('Email me a code')).toBeNull();
  });

  /** The code the user typed has to be checked against the address they typed above it. */
  it('sends the code to the address in the shared field', async () => {
    harness(['email-otp', 'password']);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'both@example.com' } });
    fireEvent.click(screen.getByText('Email me a code'));
    await waitFor(() =>
      expect(emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
        email: 'both@example.com',
        type: 'sign-in',
      }),
    );
  });

  it('does not confirm whether an address has an account when asked for a reset', async () => {
    harness(['password']);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'someone@example.com' },
    });
    fireEvent.click(screen.getByText('Forgot your password?'));
    await waitFor(() => expect(screen.getByText(/If that address has an account/)).toBeTruthy());
  });
});
