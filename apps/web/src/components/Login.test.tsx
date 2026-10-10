import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AppConfig, AuthProvider } from '@unbent/shared';
import { Login, refusalMessage } from './Login.js';
import { emailOtp, signIn } from '../auth-client.js';
import * as api from '../notes-api.js';
import { takeRelayRedirect } from '../auth-gate.js';

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
const BUILT_IN = { privacy: '/privacy', terms: '/terms' };

function harness(
  providers: AuthProvider[],
  config: Partial<AppConfig> = { legal: BUILT_IN },
  // `redirectTo` is the route's job in the app; here it only has to be somewhere, except
  // in the relay cases, which are about carrying a *particular* destination across.
  redirectTo = '/notes',
  // The code a provider round trip came back with, which only the route sets in the app.
  refusal?: string,
) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers, ...config });

  const rootRoute = createRootRoute({
    component: () => <Login redirectTo={redirectTo} refusal={refusal} />,
  });
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

  /**
   * A provider sign-in leaves the page, so its failure cannot come back in a response: it
   * comes back as a fresh load with a code in the URL. A refused sign-up — the allowlist —
   * used to end on a bare JSON page at the callback address with nothing on this screen.
   */
  it('says why a provider sent the browser back', async () => {
    harness(['google'], { legal: BUILT_IN }, '/notes', 'SIGNUPS_CLOSED');
    await waitFor(() =>
      expect(screen.getByText('This Unbent instance is not open for sign-ups.')).toBeTruthy(),
    );
  });

  it('sends a provider failure back to this screen, destination kept', async () => {
    harness(['google'], { legal: BUILT_IN }, '/device?user_code=ABCD1234');
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());
    fireEvent.click(screen.getByText('Continue with Google'));
    await waitFor(() =>
      expect(signIn.social).toHaveBeenCalledWith({
        provider: 'google',
        callbackURL: '/device?user_code=ABCD1234',
        errorCallbackURL: '/login?redirect=%2Fdevice%3Fuser_code%3DABCD1234',
      }),
    );
  });

  /** The ordinary destination needs no parameter; the URL stays the plain one. */
  it('sends a provider failure back to a plain /login for the default destination', async () => {
    harness(['google']);
    await waitFor(() => expect(screen.getByText('Continue with Google')).toBeTruthy());
    fireEvent.click(screen.getByText('Continue with Google'));
    await waitFor(() =>
      expect(signIn.social).toHaveBeenCalledWith(expect.objectContaining({ errorCallbackURL: '/login' })),
    );
  });

  /**
   * Fixed sentences per code, never the description from the URL: anyone can write a query
   * string, and a sentence in the app's own voice must be the app's. An unknown code is
   * named, so a report of it means something.
   */
  it('has a sentence for each code it knows, and names the ones it does not', () => {
    expect(refusalMessage('SIGNUPS_CLOSED')).toBe('This Unbent instance is not open for sign-ups.');
    expect(refusalMessage('access_denied')).toBe('Sign-in was cancelled before it finished.');
    expect(refusalMessage('account_not_linked')).toMatch(/^An account with this email already exists/);
    expect(refusalMessage('state_mismatch')).toBe('Sign-in did not complete (state_mismatch).');
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
  /*
   * The notice is a sentence about documents a reader can go and read. On an instance
   * publishing neither, it would point at nothing they can see, so the whole line goes
   * rather than only its links.
   */
  it('drops the consent line where the instance publishes no documents', async () => {
    harness(['password'], {});
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());
    expect(screen.queryByText(/Using Unbent is subject to/)).toBeNull();
  });

  it('links the consent line at the built-in documents', async () => {
    harness(['password']);
    await waitFor(() => expect(screen.getByText('Terms')).toBeTruthy());
    expect(screen.getByText('Terms').getAttribute('href')).toBe('/terms');
    expect(screen.getByText('Privacy Policy').getAttribute('href')).toBe('/privacy');
  });

  it('links the consent line at documents hosted elsewhere', async () => {
    const legal = { privacy: 'https://example.com/p', terms: 'https://example.com/t' };
    harness(['password'], { legal });
    await waitFor(() => expect(screen.getByText('Terms')).toBeTruthy());
    expect(screen.getByText('Terms').getAttribute('href')).toBe('https://example.com/t');
    expect(screen.getByText('Privacy Policy').getAttribute('href')).toBe('https://example.com/p');
  });

  /**
   * The preview sign-in relay button. It appears only when the server reports a relay
   * origin, which it does only on a preview — the same "the server decides which buttons to
   * draw" contract as every other method here. A preview offers the local methods too, so
   * this is an addition rather than a replacement, and it comes first because it is the only
   * one that gives a preview a Google session at all.
   */
  it('offers the relay button when the instance reports a preview relay', async () => {
    harness(['password'], { legal: BUILT_IN, previewRelay: { origin: 'https://dev.unbent.app' } });
    await waitFor(() =>
      expect(screen.getByText('Continue on the dev instance')).toBeTruthy(),
    );
  });

  it('offers no relay button when the instance reports none', async () => {
    harness(['password']);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());
    expect(screen.queryByText('Continue on the dev instance')).toBeNull();
  });

  it('puts the relay first, above the local methods a preview still offers', async () => {
    harness(['password', 'email-otp'], {
      legal: BUILT_IN,
      previewRelay: { origin: 'https://dev.unbent.app' },
    });
    await waitFor(() =>
      expect(screen.getByText('Continue on the dev instance')).toBeTruthy(),
    );
    const order = [...document.querySelectorAll('button, label')]
      .map((el) => el.textContent ?? '')
      .filter((t) => /dev instance|Email/.test(t));
    expect(order[0]).toContain('dev instance');
  });

  /**
   * Clicking it hands off to the dev instance's session-gated `/preview-relay` route, naming
   * this origin as where to return. The route rather than the API endpoint behind it, so a
   * visitor with no dev session is sent through that instance's `/login` instead of meeting a
   * JSON 401. The whole-page navigation is the point — it leaves this origin — so the test
   * pins the URL it sends the browser to rather than any in-app state.
   */
  it('hands off to the dev instance with this origin as the return', async () => {
    // jsdom's window.location is read-only; replace it with a plain object for this case so
    // the assignment the handler makes is observable.
    const original = window.location;
    const location = { origin: 'https://unbent-pr-120.of2668.workers.dev', href: '' };
    Object.defineProperty(window, 'location', { value: location, configurable: true, writable: true });
    try {
      harness(['password'], {
        legal: BUILT_IN,
        previewRelay: { origin: 'https://dev.unbent.app' },
      });
      await waitFor(() =>
        expect(screen.getByText('Continue on the dev instance')).toBeTruthy(),
      );
      fireEvent.click(screen.getByText('Continue on the dev instance'));
      expect(location.href).toBe(
        'https://dev.unbent.app/preview-relay?return=' +
          encodeURIComponent('https://unbent-pr-120.of2668.workers.dev'),
      );
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true, writable: true });
    }
  });

  /**
   * The destination survives the relay. It cannot travel in the URL — the dev instance
   * validates `return` as a bare origin — so it waits in `sessionStorage` for
   * `/preview-signin` to pick it up. Without this, opening a note signed out on a preview
   * came back to the note list instead of the note.
   */
  it('parks the destination for the return leg', async () => {
    const original = window.location;
    const location = { origin: 'https://unbent-pr-120.of2668.workers.dev', href: '' };
    Object.defineProperty(window, 'location', { value: location, configurable: true, writable: true });
    sessionStorage.clear();
    try {
      harness(
        ['password'],
        { legal: BUILT_IN, previewRelay: { origin: 'https://dev.unbent.app' } },
        '/notes/abc-123',
      );
      await waitFor(() =>
        expect(screen.getByText('Continue on the dev instance')).toBeTruthy(),
      );
      fireEvent.click(screen.getByText('Continue on the dev instance'));
      expect(takeRelayRedirect()).toBe('/notes/abc-123');
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true, writable: true });
    }
  });

  /** Nothing parked — a direct visit to the landing page — lands on the notes list. */
  it('falls back to the notes list when nothing was parked', () => {
    sessionStorage.clear();
    expect(takeRelayRedirect()).toBe('/notes');
  });
});
