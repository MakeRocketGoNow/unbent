import { useEffect } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { ensureSession } from '../auth-client.js';
import { HOME, safeRedirect } from '../auth-gate.js';
import { Login } from '../components/Login.js';

/**
 * Where to go once signed in, carried in the URL.
 *
 * A search param rather than component state because it has to survive what signing in
 * does: a provider round trip leaves and comes back, and even the local methods reload
 * nothing but do navigate. `catch` and `safeRedirect` between them mean a hand-edited or
 * hostile value drops to the default rather than erroring or being followed.
 */
const search = z.object({
  redirect: z.string().max(2048).optional().catch(undefined).transform(safeRedirect),
  /**
   * The code the auth callback redirects back with when a provider sign-in fails — the
   * refused sign-up above all. Bounded and otherwise taken as is: the screen maps known
   * codes to its own sentences and names the rest, and never shows the
   * `error_description` the callback puts beside it, so that parameter is not read.
   */
  error: z.string().max(80).optional().catch(undefined),
});

export const Route = createFileRoute('/login')({
  validateSearch: search,
  /**
   * Signing in is not something to offer somebody who already has.
   *
   * Reaching this while signed in means a stale link, a bookmark, or a second tab that
   * signed in first — in every case the answer is the page they were trying to reach.
   * There is no loop with the gate in `auth-gate.ts`: that one redirects here only when
   * there is no session, and this one leaves only when there is.
   */
  beforeLoad: async ({ search }) => {
    if (await ensureSession()) throw redirect({ href: search.redirect ?? HOME, replace: true });
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect: target, error } = Route.useSearch();
  const navigate = useNavigate();
  /**
   * Take the code back out of the address once the screen has it. Left there, a reload
   * or a Back press would show the refusal again as if it had just happened, and the
   * address bar would carry a provider's complaint while the person retries. The screen
   * seeds its message from the prop on first render, so this does not blank it.
   */
  useEffect(() => {
    if (error === undefined) return;
    void navigate({ to: '/login', search: { redirect: target }, replace: true });
  }, [error, target, navigate]);
  return <Login redirectTo={target ?? HOME} refusal={error} />;
}
