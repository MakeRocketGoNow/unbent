import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isLocalMethod } from '@unbent/shared';
import { Button } from '../components/Button.js';
import type { Passkey } from '@better-auth/passkey';
import { passkey, signIn, useSession } from '../auth-client.js';
import { TURNSTILE_FAILED_MESSAGE, useCodeRequest } from '../components/Turnstile.js';
import { configQuery } from '../queries.js';
import { isHosted } from '../app-bridge.js';
import { useSignOut } from '../useSignOut.js';

export const Route = createFileRoute('/settings/security')({
  component: SecurityPage,
});

/**
 * Where a passkey gets created, which is the only place it can be.
 *
 * Registration needs a session, so this cannot live on the sign-in screen: you sign in by
 * some other means once, add a passkey here, and every visit after that is a touch of a
 * sensor. That ordering is also what keeps recovery simple: the method that got you here
 * still works if the device holding the passkey is lost.
 *
 * Listing them matters as much as making them. A passkey is tied to one device, so anyone
 * who uses two accumulates entries, and without names and dates they are indistinguishable,
 * which makes the "revoke the one from the laptop I sold" case impossible to do safely.
 */
function SecurityPage() {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when adding a passkey is refused for a stale session. It holds the re-verification
   * panel open until a fresh sign-in mints a new session, and `add` runs again on its own.
   */
  const [reverify, setReverify] = useState(false);

  async function refresh() {
    try {
      const result = await passkey.listUserPasskeys();
      setKeys(result?.data ?? []);
    } catch (err) {
      setError((err as Error).message || 'Could not load your passkeys.');
      setKeys([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  /**
   * The name is the device, since that is the only thing that distinguishes one of these
   * from another later. Defaulted rather than prompted for: the browser is already showing
   * its own dialog, and a second one before it would be a question asked at the wrong time.
   */
  async function add() {
    setBusy(true);
    setError(null);
    try {
      const result = await passkey.addPasskey({ name: defaultPasskeyName() });
      if (result?.error) {
        /**
         * Registering a passkey needs a *fresh* session: one signed in within the last
         * day, measured from when it was created rather than last used. Better Auth guards
         * the endpoint with that check and answers 403 when it fails, which is what anyone
         * who signed in yesterday and left the tab open runs into. It is not about how they
         * signed in: Google, a code, an existing passkey all go stale the same way.
         *
         * So a stale session opens the re-verification panel rather than showing the raw
         * "Session is not fresh": the only cure is to sign in again, and this offers the
         * way to do that without leaving the page and losing the half-finished action.
         */
        if (isSessionNotFresh(result.error)) {
          setReverify(true);
        } else {
          setError(result.error.message || 'Could not add that passkey.');
        }
      } else {
        setReverify(false);
        await refresh();
      }
    } catch (err) {
      // Dismissing the browser's dialog throws here, and is a choice rather than a fault.
      if (!isCancellation(err)) setError((err as Error).message || 'Could not add that passkey.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Called by the re-verification panel once a fresh session is in place. Registration is
   * retried straight away, so the whole detour reads as one action that paused to ask who
   * you are rather than two the user has to stitch together.
   */
  async function reverified() {
    setReverify(false);
    await add();
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await passkey.deletePasskey({ id });
      await refresh();
    } catch (err) {
      setError((err as Error).message || 'Could not remove that passkey.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Passkeys</h2>
      </div>
      <p className="muted small">
        Sign in with your fingerprint, face, or screen lock instead of a password. A passkey
        stays on the device that made it, so add one on each device you use.
      </p>

      {reverify ? (
        <Reverify onVerified={() => void reverified()} onCancel={() => setReverify(false)} />
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => void add()}>
          {busy ? 'Waiting for your device…' : 'Add a passkey'}
        </Button>
      )}

      {error && <p className="bad small">{error}</p>}

      {keys === null ? (
        <p className="muted small">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="muted small">No passkeys yet.</p>
      ) : (
        <ul className="owned-list">
          {keys.map((k) => (
            <li key={k.id}>
              <span>{k.name || 'Unnamed passkey'}</span>
              {k.createdAt && (
                <span className="muted small">added {k.createdAt.toLocaleDateString()}</span>
              )}
              <Button
                variant="quiet"
                size="small"
                disabled={busy}
                onClick={() => void remove(k.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ReverifyProps {
  /** Called once a fresh session is in place, so registration can be retried. */
  onVerified: () => void;
  /** Back out without adding a passkey. */
  onCancel: () => void;
}

/**
 * Prove who you are again, so the session is fresh enough to enrol a passkey.
 *
 * A fresh session is one that has just been created, and the only thing that creates one is
 * a sign-in: no endpoint re-stamps the session you already hold. So this re-runs a sign-in
 * for the account already signed in, choosing the method by what the instance offers and by
 * what can be done without leaving the page:
 *
 * - A code by email is the first choice where it exists. It works for any account with a
 *   verified address (including the Google and passkey accounts that have no password to
 *   type) and it stays in the tab, so registration resumes the moment the code lands.
 * - A password is offered where the instance uses one, for the same reason: it re-signs in
 *   place.
 * - Failing both, the only way left is the social provider that signed the account in, and
 *   that is a full-page redirect. It cannot resume here, so the panel says to sign in again
 *   and come back: the freshly created session then lets the button through.
 *
 * The address is the one already signed in, read rather than asked for: re-verification is
 * of *this* account, so offering a different address to type would be a way to sign in as
 * someone else mid-action.
 */
function Reverify({ onVerified, onCancel }: ReverifyProps) {
  const { data: session } = useSession();
  const config = useQuery(configQuery());
  const providers = config.data?.providers ?? [];
  const otp = providers.includes('email-otp');
  const password = providers.includes('password');
  const social = providers.filter((p) => !isLocalMethod(p));
  // The instance's check in front of the request for a code is in front of this one too.
  const codeRequest = useCodeRequest(otp ? config.data?.turnstile?.siteKey : undefined);

  const email = session?.user.email ?? '';
  const signOutAndLeave = useSignOut();
  const [secret, setSecret] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await codeRequest.send(email);
      if (result?.error) setError(result.error.message || 'Could not send a code.');
      else setCodeSent(true);
    } catch (err) {
      setError((err as Error).message || 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn.emailOtp({ email, otp: code });
      if (result?.error) setError(result.error.message || 'That code did not work.');
      else onVerified();
    } catch (err) {
      setError((err as Error).message || 'That code did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn.email({ email, password: secret });
      if (result?.error) setError(result.error.message || 'That password did not work.');
      else onVerified();
    } catch (err) {
      setError((err as Error).message || 'That password did not work.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-sign in through the provider and come back here. `callbackURL` is this page, so the
   * redirect that a social sign-in cannot avoid at least lands where the action was: the
   * new session it brings back is fresh, and the Add button works on the next press.
   */
  async function reSocial(provider: string) {
    setBusy(true);
    setError(null);
    try {
      await signIn.social({ provider, callbackURL: '/settings/security' });
    } catch (err) {
      setError((err as Error).message || 'Sign-in failed.');
      setBusy(false);
    }
  }

  const intro = (
    <p className="muted small">
      Adding a passkey needs a recent sign-in, and yours has aged out. Confirm it is you and
      the passkey will be added.
    </p>
  );

  if (otp) {
    if (codeSent) {
      return (
        <form className="login-form reverify-form" onSubmit={(e) => void verifyCode(e)}>
          {intro}
          <p className="muted small">We sent a code to {email}. It expires in five minutes.</p>
          <label>
            Code
            <input
              className="login-input"
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
            {busy ? 'Confirming…' : 'Confirm and add passkey'}
          </Button>
          <Button
            variant="quiet"
            size="small"
            disabled={busy}
            onClick={() => {
              setCodeSent(false);
              setCode('');
              setError(null);
            }}
          >
            Send another code
          </Button>
          {error && <p className="bad small">{error}</p>}
        </form>
      );
    }
    return (
      <div className="login-form reverify-form">
        {intro}
        {codeRequest.widget}
        <Button variant="primary" disabled={busy || !codeRequest.ready} onClick={() => void sendCode()}>
          {busy ? 'Sending…' : `Email me a code`}
        </Button>
        <Button variant="quiet" size="small" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {codeRequest.failed && <p className="bad small">{TURNSTILE_FAILED_MESSAGE}</p>}
        {error && <p className="bad small">{error}</p>}
      </div>
    );
  }

  if (password) {
    return (
      <form className="login-form reverify-form" onSubmit={(e) => void verifyPassword(e)}>
        {intro}
        <label>
          Password
          <input
            className="login-input"
            type="password"
            autoComplete="current-password"
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy || !secret}>
          {busy ? 'Confirming…' : 'Confirm and add passkey'}
        </Button>
        <Button variant="quiet" size="small" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {error && <p className="bad small">{error}</p>}
      </form>
    );
  }

  /*
     Social-only instance, inside the Android app. The redirect below would leave for a
     browser tab (Google refuses to sign in inside an app's WebView) and the session it
     brought back would be the browser's, not the app's, so the Add button here would still
     say no. What the app does have is its own sign-in, through the phone's account sheet,
     and signing in there creates exactly the fresh session this needs. So the way through
     is to sign out and back in, said plainly, with the button to start it.
  */
  if (social.length > 0 && isHosted()) {
    return (
      <div className="login-form reverify-form">
        {intro}
        <p className="muted small">
          Sign out, sign back in, then add the passkey. Signing in again is what confirms it
          is you, and inside the app that happens on the sign-in screen.
        </p>
        <div className="login-actions">
          <Button onClick={signOutAndLeave}>Sign out</Button>
          <Button variant="quiet" size="small" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Social-only instance: no method re-signs in place, so send them back through the
  // provider. The redirect lands here and the fresh session it brings lets Add through.
  if (social.length > 0) {
    return (
      <div className="login-form reverify-form">
        {intro}
        <p className="muted small">
          Sign in again to continue. You will come back to this page, and the passkey can be
          added then.
        </p>
        <div className="login-actions">
          {social.map((p) => (
            <button
              key={p}
              type="button"
              className="provider"
              disabled={busy}
              onClick={() => void reSocial(p)}
            >
              {busy ? 'Redirecting…' : `Continue with ${socialLabel(p)}`}
            </button>
          ))}
        </div>
        <Button variant="quiet" size="small" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {error && <p className="bad small">{error}</p>}
      </div>
    );
  }

  // Nothing to re-verify with. Shouldn't happen, since the account signed in somehow, but
  // an honest dead end beats a blank panel.
  return (
    <div className="login-form reverify-form">
      {intro}
      <p className="bad small">
        Sign out and back in, then add a passkey: this instance has no way to re-verify in
        place.
      </p>
      <Button variant="quiet" size="small" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Title-cased provider id, enough to name it in a button. */
function socialLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * A name that means something in the list later.
 *
 * The user agent is the only hint the page has about which device this is, and it is a
 * label rather than a security claim, so a rough read of it is fine. Anything unrecognised
 * falls back to the date, which still beats a list of identical rows.
 */
function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone or iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return `Passkey added ${new Date().toLocaleDateString()}`;
}

/**
 * Whether a failed registration was refused for a stale session rather than anything else.
 *
 * Better Auth answers the freshness check with a 403 carrying "Session is not fresh". The
 * status is the reliable half (it is the only 403 this endpoint returns) and the message
 * is matched too, so a future 403 for some other reason does not get swept into the
 * re-verification flow it would not fix.
 */
function isSessionNotFresh(err: { status?: number; message?: string; code?: string }): boolean {
  if (err.status === 403) return true;
  const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
  return text.includes('not fresh');
}

/** Dismissing the browser's passkey dialog, which is not an error worth showing. */
function isCancellation(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}
