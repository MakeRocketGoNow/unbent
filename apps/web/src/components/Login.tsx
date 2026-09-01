import { useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { signIn } from '../auth-client.js';

type Provider = 'google' | 'github';

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'github', label: 'Continue with GitHub' },
];

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
       */
      await signIn.social({ provider, callbackURL: href });
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
