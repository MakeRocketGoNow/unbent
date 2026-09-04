import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { resetPassword } from '../auth-client.js';

/**
 * Better Auth redirects here with either a usable token or an explanation of why there
 * isn't one. Both are `catch`-ed so a hand-typed or truncated link renders a message
 * rather than an error page.
 */
const search = z.object({
  token: z.string().trim().min(1).max(512).optional().catch(undefined),
  error: z.string().trim().max(64).optional().catch(undefined),
});

export const Route = createFileRoute('/reset-password')({
  validateSearch: search,
  component: ResetPasswordPage,
});

/**
 * The other end of the reset mail.
 *
 * Deliberately outside the signed-in layout: someone resetting a password is by definition
 * unable to sign in, so this page has to render without a session. Better Auth has already
 * checked the token by the time the redirect lands here, and says so in the query string.
 */
function ResetPasswordPage() {
  const { token, error: tokenError } = Route.useSearch();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await resetPassword({ newPassword: password, token });
      if (result?.error) {
        setError(result.error.message || 'Could not reset your password.');
      } else {
        setDone(true);
      }
    } catch (err) {
      setError((err as Error).message || 'Could not reset your password.');
    } finally {
      setBusy(false);
    }
  }

  if (tokenError || !token) {
    return (
      <div className="login">
        <h1>Unbent</h1>
        <p className="bad">
          That reset link has expired or has already been used. Reset links work once and
          last an hour.
        </p>
        <Button variant="primary" onClick={() => void navigate({ to: '/notes' })}>
          Back to sign in
        </Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="login">
        <h1>Unbent</h1>
        <p>
          Your password is changed, and any other devices that were signed in have been
          signed out.
        </p>
        <Button variant="primary" onClick={() => void navigate({ to: '/notes' })}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="login">
      <h1>Unbent</h1>
      <p className="tagline">Choose a new password.</p>
      <form className="login-form" onSubmit={(e) => void submit(e)}>
        <label>
          New password
          <input
            className="login-input"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
      {error && <p className="bad">{error}</p>}
    </div>
  );
}
