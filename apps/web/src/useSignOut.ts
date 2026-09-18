import { useNavigate } from '@tanstack/react-router';
import { signOut, refreshSession } from './auth-client.js';

/**
 * Sign out, and land somewhere that makes sense afterwards.
 *
 * Extracted from the root layout because more than one place offers the action: the rail's
 * account menu, the drawer's, which is the only one on a phone, and the phone's top bar on
 * the pages that keep one. The order below is the
 * whole reason this is not three lines written twice.
 *
 * Leaving a note id in the address bar would expose it to the next person and reapply it on
 * the next sign-in, so this goes to `/login` rather than staying put and letting the gate
 * bounce it there a moment later.
 *
 * The session is refetched before navigating rather than left to settle on its own:
 * `/login` turns away anyone who is signed in, and it reads the same store this call is in
 * the middle of emptying.
 *
 * Nothing is dropped from the query cache here. The rows this user loaded are still in
 * memory afterwards, and deliberately so — see `claimCacheFor`, which empties the cache
 * when the *next* user arrives, where there is no mounted app left to refetch into a 401.
 *
 * It lives beside `auth-client.ts` rather than inside it because that module is deliberately
 * free of the router and of React; this is the seam where the two meet.
 */
export function useSignOut(): () => void {
  const navigate = useNavigate();
  return () => {
    void signOut()
      .then(() => refreshSession())
      .then(() => navigate({ to: '/login', replace: true }));
  };
}
