import { useState } from 'react';
import { signIn } from '../auth-client.js';

type Provider = 'google' | 'github';

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'github', label: 'Continue with GitHub' },
];

export function Login() {
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(provider: Provider) {
    setPending(provider);
    setError(null);
    try {
      await signIn.social({ provider, callbackURL: '/' });
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
