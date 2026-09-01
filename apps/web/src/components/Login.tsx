import { useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { signIn } from '../auth-client.js';

type Provider = 'google' | 'github';

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'github', label: 'Continue with GitHub' },
];

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

export function Login() {
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Through the router rather than `window.location`, which `url-boundary.test.ts` forbids
  // so that navigation stays the router's business. `href` is the path and query together.
  const { href } = useLocation();

  async function start(provider: Provider) {
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
      // A provider with no configured credentials fails here rather than redirecting.
      setError((err as Error).message || 'Sign-in failed');
      setPending(null);
    }
  }

  return (
    <div className="login">
      <h1>Unbent</h1>
      <p className="tagline">Notes in Markdown that you can always take with you.</p>

      <div className="login-actions">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="provider"
            disabled={pending !== null}
            onClick={() => void start(p.id)}
          >
            {pending === p.id ? 'Redirecting…' : p.label}
          </button>
        ))}
      </div>

      {error && <p className="bad">{error}</p>}
    </div>
  );
}
