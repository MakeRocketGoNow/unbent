import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { AuthProvider } from '@unbent/shared';
import { emailOtp, requestPasswordReset, signIn, signUp } from '../auth-client.js';
import { configQuery } from '../queries.js';
import { Button } from './Button.js';

/** The providers that redirect to somebody else's site. The local methods stay here. */
type Social = Exclude<AuthProvider, 'password' | 'passkey' | 'email-otp'>;

const SOCIAL_LABEL: Record<Social, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

/** Where the app lands when the current URL is not somewhere worth returning to. */
const HOME = '/notes';

/**
 * Where to come back to after signing in.
 *
 * Deep links keep their query string, which is what lets a device approval survive a
 * sign-in. `/device` without a code does not: there is nothing there to act on, and a code
 * that has since been used or has expired renders an error that looks like the sign-in
 * failed rather than like a stale link.
 */
export function returnTo(href: string): string {
  const [path, query = ''] = href.split('?');
  if (path !== '/device') return href;
  // Matched rather than parsed with the browser's query-string API, which
  // `url-boundary.test.ts` reserves for outbound API queries so that browser URL handling
  // stays the router's business.
  const hasCode = /(^|&)user_code=[^&]/.test(query);
  return hasCode ? href : HOME;
}

/** Better Auth reports failures two ways; this flattens both to something showable. */
function asMessage(err: unknown): string {
  return (err as Error)?.message || 'Sign-in failed';
}

/**
 * The sign-in screen, drawn from what the instance says it offers.
 *
 * It used to hardcode Google and GitHub, so a provider with no credentials behind it was
 * still a button, and it failed only when pressed. Now `/api/config` decides: unbent.app
 * shows the two providers, a self-hosted instance typically shows a password form, and
 * one that offers both shows both with a divider between them.
 *
 * Passkeys sit above the rest, because for anyone who has one they are the whole screen:
 * the browser offers the credential from the email field before a key is pressed, and a
 * touch of a sensor is the entire interaction. Everyone else sees what they saw before.
 */
export function Login() {
  const config = useQuery(configQuery());
  const [pending, setPending] = useState<AuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Through the router rather than `window.location`, which `url-boundary.test.ts` forbids
  // so that navigation stays the router's business. `href` is the path and query together.
  const { href } = useLocation();

  const providers = config.data?.providers ?? [];
  const social = providers.filter(
    (p): p is Social => p !== 'password' && p !== 'passkey' && p !== 'email-otp',
  );
  const password = providers.includes('password');
  const passkeys = providers.includes('passkey');
  const otp = providers.includes('email-otp');

  async function startSocial(provider: Social) {
    setPending(provider);
    setError(null);
    try {
      /**
       * Come back to the page that was asked for, query string included.
       *
       * This used to always return to `/`, on the reasoning that preserving the URL meant
       * widening the server's trusted-redirect allowlist. It does not: Better Auth
       * validates `callbackURL` with `allowRelativePaths`, so a same-origin path needs no
       * allowlist entry, and building one here from `pathname + search` can never produce
       * an absolute URL pointing somewhere else.
       *
       * The device flow is what made this matter. `/device?user_code=ABCD1234` opened
       * while signed out sent the user to `/notes` with the code silently dropped, and the
       * CLI waiting on an approval page they had no way back to.
       *
       * A bare `/device` is the exception, and returns to the notes instead. Without a
       * code there is nothing to approve, so landing there after signing in is a dead end
       * — and since a code is single-use and expires in 30 minutes, a stale one is worse
       * than a dead end: it shows an error that reads as sign-in being broken.
       */
      await signIn.social({ provider, callbackURL: returnTo(href) });
    } catch (err) {
      setError((err as Error).message || 'Sign-in failed');
      setPending(null);
    }
  }

  /**
   * Sign in with a passkey the user picks from the browser's own dialog.
   *
   * Separate from the autofill path below, which offers a credential before anything is
   * typed. This is the explicit press, for when the dialog was dismissed or the browser
   * never offered one.
   */
  async function startPasskey() {
    setPending('passkey');
    setError(null);
    try {
      const result = await signIn.passkey();
      // Reported in `error` rather than thrown, as elsewhere on this client.
      if (result?.error) {
        setError(result.error.message || 'That passkey did not work.');
      }
      // On success the session hook in the root layout re-renders the app in place, so
      // there is no redirect to make and the deep link in the address bar survives.
    } catch (err) {
      setError(asMessage(err));
    } finally {
      setPending(null);
    }
  }

  /**
   * Offer a passkey from the email field's autofill, before anything is typed.
   *
   * This is WebAuthn conditional UI: the browser quietly checks whether it holds a
   * credential for this origin and, if it does, puts it in the dropdown alongside saved
   * addresses. Nothing is shown if there is none, which is why it can run unconditionally
   * on mount — for a first-time visitor it is invisible.
   *
   * Deliberately unawaited and its failures swallowed: the call sits open waiting for a
   * choice that may never come, and a browser without support rejects immediately. Either
   * way it is not something to report — every other way in is still on screen.
   */
  useEffect(() => {
    if (!passkeys) return;
    void signIn.passkey({ autoFill: true }).catch(() => {});
  }, [passkeys]);

  return (
    <div className="login">
      <h1>Unbent</h1>
      <p className="tagline">Notes in Markdown that you can always take with you.</p>

      {config.isError && (
        <p className="bad">Couldn't load the sign-in options. {(config.error as Error).message}</p>
      )}

      {passkeys && (
        <div className="login-actions">
          <button
            type="button"
            className="provider"
            disabled={pending !== null}
            onClick={() => void startPasskey()}
          >
            {pending === 'passkey' ? 'Waiting for your device…' : 'Sign in with a passkey'}
          </button>
        </div>
      )}

      {otp && (
        <>
          {passkeys && <div className="login-or">or</div>}
          <EmailOtpForm
            busy={pending !== null}
            onBusy={(b) => setPending(b ? 'email-otp' : null)}
            onError={setError}
          />
        </>
      )}

      {social.length > 0 && (
        <div className="login-actions">
          {(passkeys || otp) && <div className="login-or">or</div>}
          {social.map((p) => (
            <button
              key={p}
              type="button"
              className="provider"
              disabled={pending !== null}
              onClick={() => void startSocial(p)}
            >
              {pending === p ? 'Redirecting…' : SOCIAL_LABEL[p]}
            </button>
          ))}
        </div>
      )}

      {password && (
        <>
          {(social.length > 0 || passkeys || otp) && <div className="login-or">or</div>}
          <PasswordForm
            busy={pending !== null}
            onBusy={(b) => setPending(b ? 'password' : null)}
            onError={setError}
          />
        </>
      )}

      {config.isSuccess && providers.length === 0 && (
        <p className="muted">This Unbent has no sign-in method configured.</p>
      )}

      {error && <p className="bad">{error}</p>}
    </div>
  );
}

interface PasswordFormProps {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
}

/**
 * Email and password, with a toggle to create an account instead.
 *
 * No `callbackURL`: the session hook in the root layout re-renders the app in place once
 * the cookie lands, and the deep link that was opened stays in the address bar — the same
 * behaviour the layout already promises, without a redirect that would reload the page.
 * The social buttons redirect because a provider round trip leaves them no choice.
 *
 * A name field appears only for sign-up, where Better Auth requires one. Asking for it on
 * every sign-in would be a field the returning user has to skip past.
 */
function PasswordForm({ busy, onBusy, onError }: PasswordFormProps) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [sentReset, setSentReset] = useState(false);

  /**
   * Ask for a reset link.
   *
   * Reports success whatever the server says, and says "if that address has an account"
   * rather than "sent": answering honestly would turn this box into a way to ask whether
   * any given person has an account here. Better Auth's endpoint is quiet for the same
   * reason, so there is nothing to distinguish anyway.
   */
  async function requestReset() {
    if (!email) {
      onError('Enter your email address first, then ask for a reset link.');
      return;
    }
    onBusy(true);
    onError(null);
    try {
      await requestPasswordReset({ email, redirectTo: '/reset-password' });
      setSentReset(true);
    } catch {
      setSentReset(true);
    } finally {
      onBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    onBusy(true);
    onError(null);
    try {
      // The client reports failures in `error` rather than throwing, so both are checked:
      // a refused sign-up (the allowlist) arrives as the former, a network fault as the latter.
      const result =
        mode === 'in'
          ? await signIn.email({ email, password })
          : await signUp.email({ email, password, name: name.trim() || email });
      if (result.error) {
        onError(result.error.message || 'Sign-in failed');
      }
    } catch (err) {
      onError((err as Error).message || 'Sign-in failed');
    } finally {
      onBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(e) => void submit(e)}>
      {mode === 'up' && (
        <label>
          Name
          <input
            className="login-input"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <label>
        Email
        <input
          className="login-input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        Password
        <input
          className="login-input"
          type="password"
          autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <Button variant="primary" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : mode === 'in' ? 'Sign in' : 'Create account'}
      </Button>
      <Button
        variant="quiet"
        size="small"
        className="login-switch"
        disabled={busy}
        onClick={() => setMode(mode === 'in' ? 'up' : 'in')}
      >
        {mode === 'in' ? 'Create an account' : 'I already have an account'}
      </Button>
      {mode === 'in' &&
        (sentReset ? (
          <p className="muted">
            If that address has an account, a reset link is on its way. It works once and
            expires in an hour.
          </p>
        ) : (
          <Button
            variant="quiet"
            size="small"
            className="login-switch"
            disabled={busy}
            onClick={() => void requestReset()}
          >
            Forgot your password?
          </Button>
        ))}
    </form>
  );
}

interface EmailOtpFormProps {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
}

/**
 * A six-digit code by email, in two steps.
 *
 * The step that matters is the second one: the code is typed back into the same page that
 * asked for it. A magic link would have been one fewer thing to type, but on a phone the
 * link opens in whichever browser the mail app prefers — often not the one waiting for it,
 * and on Android not the app's Custom Tab either — so the session lands somewhere the user
 * cannot see. A code cannot go to the wrong place.
 *
 * No separate sign-up: an address with no account gets one, so there is no second form to
 * find and no wrong guess to make about which one you need. The instance's allowlist still
 * decides, and says so in its own words when it refuses.
 */
function EmailOtpForm({ busy, onBusy, onError }: EmailOtpFormProps) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    onBusy(true);
    onError(null);
    try {
      const result = await emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (result?.error) onError(result.error.message || 'Could not send a code.');
      else setSent(true);
    } catch (err) {
      onError(asMessage(err));
    } finally {
      onBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    onBusy(true);
    onError(null);
    try {
      const result = await signIn.emailOtp({ email, otp: code });
      // A wrong code is reported here rather than thrown. The plugin burns the code after
      // three tries, so the message has to be shown rather than silently retried.
      if (result?.error) onError(result.error.message || 'That code did not work.');
      // On success the root layout's session hook re-renders in place, so the deep link in
      // the address bar survives — the same reason the password form has no callbackURL.
    } catch (err) {
      onError(asMessage(err));
    } finally {
      onBusy(false);
    }
  }

  if (!sent) {
    return (
      <form className="login-form" onSubmit={(e) => void send(e)}>
        <label>
          Email
          <input
            className="login-input"
            type="email"
            /**
             * `webauthn` alongside the usual token is what lets the browser offer a passkey
             * from this field's autofill, next to saved addresses. Harmless where there is
             * no passkey, and the reason `signIn.passkey({ autoFill: true })` has somewhere
             * to attach.
             */
            autoComplete="username webauthn"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Email me a code'}
        </Button>
      </form>
    );
  }

  return (
    <form className="login-form" onSubmit={(e) => void verify(e)}>
      <p className="muted">
        We sent a code to {email}. It expires in five minutes.
      </p>
      <label>
        Code
        <input
          className="login-input"
          /**
           * Not `type="number"`: a leading zero would be dropped and the spinners are
           * meaningless here. `inputMode` gets the numeric keypad on a phone, and
           * `one-time-code` is what makes iOS and Android offer the code straight from
           * the notification, which is the whole reason this beats a link.
           */
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      <Button variant="primary" type="submit" disabled={busy || code.length < 6}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <Button
        variant="quiet"
        size="small"
        className="login-switch"
        disabled={busy}
        onClick={() => {
          // Back to the address, so a typo is fixable without reloading the page.
          setSent(false);
          setCode('');
          onError(null);
        }}
      >
        Use a different address
      </Button>
    </form>
  );
}
