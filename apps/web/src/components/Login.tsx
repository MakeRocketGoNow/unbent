import { Fragment, useEffect, useState, type FormEvent, type JSX } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { SIGNUPS_CLOSED_MESSAGE, isLocalMethod, type AuthProvider } from '@unbent/shared';
import {
  refreshSession,
  requestPasswordReset,
  signIn,
  signUp,
} from '../auth-client.js';
import { configQuery } from '../queries.js';
import { HOME, LOGIN, rememberRelayRedirect } from '../auth-gate.js';
import { Button } from './Button.js';
import { LegalLink } from './LegalLink.js';
import { ProviderIcon } from './provider-icons.js';
import { TURNSTILE_FAILED_MESSAGE, useCodeRequest } from './Turnstile.js';

/**
 * Names for providers whose own spelling is not what title-casing the id would produce.
 *
 * Only the awkward ones need an entry. Anything absent is title-cased from its id, which
 * is what makes an instance able to enable a provider this file has never heard of:
 * `DISCORD_CLIENT_ID` on the server is enough to get a working "Continue with Discord"
 * here, with no change on this side at all.
 */
const SOCIAL_NAME: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  vk: 'VK',
  wechat: 'WeChat',
  huggingface: 'Hugging Face',
  paypal: 'PayPal',
  'exact-online': 'Exact Online',
};

function socialLabel(id: string): string {
  const name = SOCIAL_NAME[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
  return `Continue with ${name}`;
}

/** Better Auth reports failures two ways; this flattens both to something showable. */
function asMessage(err: unknown): string {
  return (err as Error)?.message || 'Sign-in failed';
}

export interface LoginProps {
  /**
   * Where to go once signed in: a path on this origin, already checked by the route that
   * reads it out of the URL. The screen does not work this out for itself: it is rendered
   * at `/login`, which is nobody's destination.
   */
  redirectTo: string;
  /**
   * Why a provider sign-in came back here instead of signing in: the `error` code the
   * auth callback put in the URL, read by the route. A provider round trip leaves the page,
   * so its failure cannot arrive in a response the way the code and password forms' do: it
   * arrives as a fresh load of this screen with a code in the query string. Absent on a
   * plain visit.
   */
  refusal?: string;
}

/**
 * The sentence for a code the auth callback sent the browser back with.
 *
 * A fixed sentence per code rather than the `error_description` beside it in the URL:
 * anyone can write a query string, and text shown in the app's own voice must be the
 * app's. `SIGNUPS_CLOSED` is this server's own (the allowlist hook in the API);
 * `access_denied` is what a provider sends when the person backs out at its consent
 * screen; `account_not_linked` is Better Auth refusing to join a provider to an existing
 * account whose address was never confirmed (`requireLocalEmailVerified`): an account
 * made with a password, say. An email code confirms the address, and the provider links
 * itself on the next try; there is no "add Google" in Settings to point at instead.
 * Anything else is shown by name so a report of it means something.
 */
export function refusalMessage(code: string): string {
  switch (code) {
    case 'SIGNUPS_CLOSED':
      return SIGNUPS_CLOSED_MESSAGE;
    case 'access_denied':
      return 'Sign-in was cancelled before it finished.';
    case 'account_not_linked':
      return 'An account with this email already exists and its address is not confirmed yet. Sign in with an email code first, and this sign-in will work after that.';
    default:
      return `Sign-in did not complete (${code}).`;
  }
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
export function Login({ redirectTo, refusal }: LoginProps) {
  const config = useQuery(configQuery());
  // Absent on an instance that publishes neither document; see the consent line below.
  const legal = config.data?.legal;
  const [pending, setPending] = useState<AuthProvider | null>(null);
  // Seeded from the URL's code once, so it survives the route taking the code back out of
  // the address, and clears like any other error on the next attempt.
  const [error, setError] = useState<string | null>(refusal ? refusalMessage(refusal) : null);
  // Through the router rather than `window.location`, which `url-boundary.test.ts` forbids
  // so that navigation stays the router's business.
  const navigate = useNavigate();

  /**
   * What every sign-in that stays in this tab ends with.
   *
   * The session is refetched *before* navigating, not after. The destination has a guard
   * in front of it and loaders behind it, and both run before anything renders, so
   * arriving with the previous answer still cached either bounces straight back here or
   * fires the note list's requests without a cookie. The second is what used to happen:
   * signing in swapped the login screen for "Something went wrong! 401 Unauthorized",
   * and only a reload got past it.
   *
   * `replace`, so Back goes to wherever the user was before signing in rather than to a
   * sign-in screen that now bounces forward again.
   */
  async function landed() {
    await refreshSession();
    await navigate({ href: redirectTo, replace: true });
  }

  const providers = config.data?.providers ?? [];
  // Anything the server reports that this codebase does not implement itself is an OAuth
  // provider, and gets a button whether or not this file has heard of it.
  const social = providers.filter((p) => !isLocalMethod(p));
  const password = providers.includes('password');
  const passkeys = providers.includes('passkey');
  const otp = providers.includes('email-otp');
  // Where the instance puts a Turnstile check in front of the request for a code (MAK-243).
  const turnstile = config.data?.turnstile?.siteKey;
  // Set only on a preview, where it names the dev instance that can sign in with Google on
  // this preview's behalf. See the relay button below and routes/preview-signin.tsx.
  const relayOrigin = config.data?.previewRelay?.origin;

  /**
   * Start the preview sign-in relay: hand off to the dev instance to sign in there.
   *
   * A preview cannot register an OAuth callback for a hostname that changes every PR, so it
   * borrows a Google session from the standing dev instance instead. This sends the browser
   * to that instance's `/api/preview-relay/start`, naming this origin as where to come back
   * to; the dev instance signs the user in (if they are not already), mints a one-time
   * token, and redirects to `/preview-signin` here, which redeems it.
   *
   * It lands on the dev instance's `/preview-relay` *route*, not the API endpoint behind
   * it. That route is session-gated, so a visitor with no dev session is sent through
   * `/login` there and returned to it once they have one; going straight at the endpoint
   * answered that same visitor with a JSON 401, which is precisely the person the relay
   * exists for.
   *
   * A full-page navigation like the social buttons, and for the same reason: it leaves this
   * origin entirely, so it uses `location` rather than the router, the way `/connect` hands
   * off to an app scheme. The return origin goes through `encodeURIComponent` rather than the
   * query-string builder that `url-boundary.test.ts` reserves for outbound API queries.
   */
  function startRelay(origin: string) {
    setPending('preview-relay');
    setError(null);
    // `return` is validated as a bare origin on the other side, so the destination cannot
    // travel in the URL. It waits here instead and `/preview-signin` picks it up.
    rememberRelayRedirect(redirectTo);
    window.location.href = `${origin}/preview-relay?return=${encodeURIComponent(window.location.origin)}`;
  }

  async function startSocial(provider: string) {
    setPending(provider);
    setError(null);
    try {
      /**
       * Come back to the page that was asked for, query string included.
       *
       * This used to always return to `/`, on the reasoning that preserving the URL meant
       * widening the server's trusted-redirect allowlist. It does not: Better Auth
       * validates `callbackURL` with `allowRelativePaths`, so a same-origin path needs no
       * allowlist entry, and `redirectTo` is a path on this origin by construction: the
       * route checked it before handing it over.
       *
       * The device flow is what made this matter. `/device?user_code=ABCD1234` opened
       * while signed out sent the user to `/notes` with the code silently dropped, and the
       * CLI waiting on an approval page they had no way back to.
       *
       * This is the one method that leaves the page, so it is the one that cannot use
       * `landed`: the provider brings the browser back with a fresh load, and the guard
       * on the destination reads the cookie that arrived with it.
       *
       * `errorCallbackURL` is this screen again, destination kept, because a failure on
       * the way back has nowhere else to be shown: the callback route redirects a coded
       * error there with `?error=`, which the route reads and `refusal` carries in. Without
       * it Better Auth sends the browser to its own generic `/api/auth/error` page, outside
       * the app and with no way back, and a refused sign-up (the allowlist) used to end on
       * a bare JSON 403 at the callback address, message included and no way back.
       * `encodeURIComponent` rather than the query-string builder, as `startRelay` does and
       * for its reason.
       */
      const back = redirectTo === HOME ? LOGIN : `${LOGIN}?redirect=${encodeURIComponent(redirectTo)}`;
      await signIn.social({ provider, callbackURL: redirectTo, errorCallbackURL: back });
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
      } else {
        await landed();
      }
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
   * on mount: for a first-time visitor it is invisible.
   *
   * Deliberately unawaited and its failures swallowed: the call sits open waiting for a
   * choice that may never come, and a browser without support rejects immediately. Either
   * way it is not something to report: every other way in is still on screen.
   */
  useEffect(() => {
    if (!passkeys) return;
    void signIn.passkey({ autoFill: true }).catch(() => {});
  }, [passkeys]);

  /**
   * The methods on offer, in the order they are shown, with the dividers left to the
   * renderer below.
   *
   * A list rather than four conditional blocks because the blocks had to each work out
   * whether anything preceded them in order to decide about a divider, which meant the
   * order lived in four `||` chains that all had to agree, and reordering meant editing
   * every one of them. Here the order is the order of this array.
   *
   * Social first: it is one tap for most people and needs nothing typed. Passkeys are
   * faster still but only for someone who already has one, which is nobody on a first
   * visit. The email code needs a round trip through another app, and a password is the
   * one thing to be remembered, so they come last in that order.
   */
  const sections = [
    // First on a preview, because it is the one method that gives a preview a Google session
    // at all; the local methods below stay for anyone who would rather sign in directly.
    relayOrigin && {
      key: 'preview-relay',
      node: (
        <div className="login-actions">
          <button
            type="button"
            className="provider"
            disabled={pending !== null}
            onClick={() => startRelay(relayOrigin)}
          >
            {pending === 'preview-relay' ? 'Redirecting…' : 'Continue on the dev instance'}
          </button>
        </div>
      ),
    },
    social.length > 0 && {
      key: 'social',
      node: (
        <div className="login-actions">
          {social.map((p) => (
            <button
              key={p}
              type="button"
              className="provider"
              disabled={pending !== null}
              onClick={() => void startSocial(p)}
            >
              <ProviderIcon provider={p} />
              {pending === p ? 'Redirecting…' : socialLabel(p)}
            </button>
          ))}
        </div>
      ),
    },
    passkeys && {
      key: 'passkey',
      node: (
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
      ),
    },
    // One section whether an instance offers a code, a password, or both: the address is
    // asked for once and the ways to proceed hang off it.
    (otp || password) && {
      key: 'email',
      node: (
        <EmailForm
          otp={otp}
          password={password}
          turnstile={turnstile}
          busy={pending !== null}
          onBusy={(b) => setPending(b ? (password ? 'password' : 'email-otp') : null)}
          onError={setError}
          onSignedIn={landed}
        />
      ),
    },
  ].filter((s): s is { key: string; node: JSX.Element } => Boolean(s));

  return (
    <div className="login">
      <h1>Unbent</h1>
      <p className="tagline">Notes, receipts and scans you can search, and take with you whenever you like.</p>

      {config.isError && (
        <p className="bad">Couldn't load the sign-in options. {(config.error as Error).message}</p>
      )}

      {sections.map((section, i) => (
        <Fragment key={section.key}>
          {i > 0 && <div className="login-or">or</div>}
          {section.node}
        </Fragment>
      ))}

      {config.isSuccess && providers.length === 0 && (
        <p className="muted">This Unbent has no sign-in method configured.</p>
      )}

      {error && <p className="bad">{error}</p>}

      {/* Notice, not agreement. Signing in and signing up are one press here, so the
          agreement is asked for after it, on a screen of its own (`LegalAgreement`); this
          line used to say "By continuing you agree", which became a second, different
          claim about when someone agreed, one screen before the real one. It stays as the
          only route to these pages for someone who has no account and cannot reach the
          account menu.

          The whole line goes when the instance publishes neither document, rather than
          leaving a sentence about documents a reader cannot go and read. */}
      {legal && (
        <p className="login-legal">
          Using Unbent is subject to its <LegalLink href={legal.terms}>Terms</LegalLink> and{' '}
          <LegalLink href={legal.privacy}>Privacy Policy</LegalLink>.
        </p>
      )}
    </div>
  );
}

interface EmailFormProps {
  /** Whether this instance offers a code by email, a password, or both. */
  otp: boolean;
  password: boolean;
  /** Turnstile's site key, where the instance asks for a token with the request for a code. */
  turnstile?: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  /** Called once a cookie is in place; see `landed` above for what it does with that. */
  onSignedIn: () => Promise<void>;
}

/**
 * Everything that starts with an email address, in one form.
 *
 * The two email methods used to be separate components rendered one after the other, which
 * on an instance offering both produced two "Email" boxes a divider apart: the same
 * address, asked for twice, with nothing on screen saying they were the same question.
 *
 * So the address is asked once and the ways to proceed hang off it. A password box and
 * "Sign in" when passwords are on; "Email me a code" when codes are on; both, stacked,
 * when both are. An instance offering one method looks exactly as it did before.
 *
 * Which is primary when both exist: the password. Someone who has one is signing in with
 * it, and a code is the fallback for having forgotten it or never set one: the same
 * reason "Forgot your password?" sits nearby rather than on a page of its own.
 *
 * No `callbackURL` on any of these: nothing here leaves the page, so the cookie lands in
 * the response and `onSignedIn` navigates. The social buttons redirect because a provider
 * round trip leaves them no choice.
 *
 * Where the instance has put Turnstile in front of the request for a code, its widget sits
 * above that button and the button waits for the token (`useCodeRequest`). The widget is
 * drawn whenever a code is offered, before anyone has chosen it: it usually marks itself
 * done before the address is typed, and a widget that appeared on the press would move the
 * button under the pointer. Offline the script never arrives, and the sentence under the
 * button says so rather than leaving a button that cannot be pressed.
 */
function EmailForm({ otp, password, turnstile, busy, onBusy, onError, onSignedIn }: EmailFormProps) {
  const codeRequest = useCodeRequest(otp ? turnstile : undefined);
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [sentReset, setSentReset] = useState(false);
  /** Set once a code is on its way, which swaps the whole form for the code step. */
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');

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

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    onBusy(true);
    onError(null);
    try {
      // The client reports failures in `error` rather than throwing, so both are checked:
      // a refused sign-up (the allowlist) arrives as the former, a network fault as the latter.
      const result =
        mode === 'in'
          ? await signIn.email({ email, password: secret })
          : await signUp.email({ email, password: secret, name: email });
      if (result.error) onError(result.error.message || 'Sign-in failed');
      else await onSignedIn();
    } catch (err) {
      onError(asMessage(err));
    } finally {
      onBusy(false);
    }
  }

  async function sendCode() {
    if (!email) {
      onError('Enter your email address first, then ask for a code.');
      return;
    }
    onBusy(true);
    onError(null);
    try {
      const result = await codeRequest.send(email);
      if (result?.error) onError(result.error.message || 'Could not send a code.');
      else setCodeSent(true);
    } catch (err) {
      onError(asMessage(err));
    } finally {
      onBusy(false);
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    onBusy(true);
    onError(null);
    try {
      const result = await signIn.emailOtp({ email, otp: code });
      // A wrong code is reported here rather than thrown. The plugin burns the code after
      // three tries, so the message has to be shown rather than silently retried.
      if (result?.error) onError(result.error.message || 'That code did not work.');
      else await onSignedIn();
    } catch (err) {
      onError(asMessage(err));
    } finally {
      onBusy(false);
    }
  }

  /** The code step replaces the form: there is nothing else to do until it is entered. */
  if (codeSent) {
    return (
      <form className="login-form" onSubmit={(e) => void verifyCode(e)}>
        <p className="muted">We sent a code to {email}. It expires in five minutes.</p>
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
            setCodeSent(false);
            setCode('');
            onError(null);
          }}
        >
          Use a different address
        </Button>
      </form>
    );
  }

  return (
    <form className="login-form" onSubmit={(e) => void (password ? submitPassword(e) : e.preventDefault())}>
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

      {password && (
        <label>
          Password
          <input
            className="login-input"
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}

      {password && (
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </Button>
      )}

      {codeRequest.widget}

      {otp && (
        <Button
          // Primary only when it is the only way forward; beside a password it is the
          // alternative, and two filled buttons would be a choice with no default.
          variant={password ? 'quiet' : 'primary'}
          type="button"
          disabled={busy || !codeRequest.ready}
          tip={codeRequest.waiting}
          onClick={() => void sendCode()}
        >
          {busy && !password ? 'Sending…' : 'Email me a code'}
        </Button>
      )}

      {codeRequest.failed && <p className="bad small">{TURNSTILE_FAILED_MESSAGE}</p>}

      {password && (
        <Button
          variant="quiet"
          size="small"
          className="login-switch"
          disabled={busy}
          onClick={() => setMode(mode === 'in' ? 'up' : 'in')}
        >
          {mode === 'in' ? 'Create an account' : 'I already have an account'}
        </Button>
      )}

      {password &&
        mode === 'in' &&
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
