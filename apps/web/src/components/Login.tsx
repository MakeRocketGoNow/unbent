import { useState, type FormEvent } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { AuthProvider } from '@unbent/shared';
import { signIn, signUp } from '../auth-client.js';
import { configQuery } from '../queries.js';
import { Button } from './Button.js';

/** The providers with a button of their own: everything the instance offers but a password. */
type Social = Exclude<AuthProvider, 'password'>;

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

/**
 * The sign-in screen, drawn from what the instance says it offers.
 *
 * It used to hardcode Google and GitHub, so a provider with no credentials behind it was
 * still a button, and it failed only when pressed. Now `/api/config` decides: unbent.app
 * shows the two providers, a self-hosted instance typically shows a password form, and
 * one that offers both shows both with a divider between them.
 */
export function Login() {
  const config = useQuery(configQuery());
  const [pending, setPending] = useState<AuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Through the router rather than `window.location`, which `url-boundary.test.ts` forbids
  // so that navigation stays the router's business. `href` is the path and query together.
  const { href } = useLocation();

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

  const providers = config.data?.providers ?? [];
  const social = providers.filter((p): p is Social => p !== 'password');
  const password = providers.includes('password');

  return (
    <div className="login">
      <h1>Unbent</h1>
      <p className="tagline">Notes in Markdown that you can always take with you.</p>

      {config.isError && (
        <p className="bad">Couldn't load the sign-in options. {(config.error as Error).message}</p>
      )}

      {social.length > 0 && (
        <div className="login-actions">
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
          {social.length > 0 && <div className="login-or">or</div>}
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
    </form>
  );
}
