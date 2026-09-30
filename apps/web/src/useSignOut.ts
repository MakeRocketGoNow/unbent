import { useNavigate } from '@tanstack/react-router';
import { signOut, refreshSession } from './auth-client.js';
import { postToApp } from './app-bridge.js';
import { forgetSession } from './session-memory.js';
import { clearOfflineCaches } from './offline-cache.js';

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
 * In a browser, the session is refetched before navigating rather than left to settle on its own:
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
    void signOut().then(() => {
      // Before anything that can return early: whoever this device remembers as signed in
      // (`session-memory.ts`), and the copies of their notes kept for reading offline
      // (`offline-cache.ts`), must not outlive a sign-out — or the next time the app opened
      // with no connection it would carry on as them.
      forgetSession();
      void clearOfflineCaches();
      /*
       * Inside the Android app, the app still holds its own copy of the session and
       * would put it back into the page on the next launch, as if the sign-out had
       * never happened. Telling it is what makes it forget, and it replaces this screen
       * with its own sign-in.
       *
       * Told before the session store is refreshed, not after. Emptying the store is what
       * makes the shell in `__root.tsx` post `unauthorized` and navigate to `/login`, so
       * refreshing first would send the app a session check it is about to throw away,
       * and flash `/login` in a screen on its way out.
       */
      if (postToApp({ type: 'signed-out' })) return;
      return refreshSession().then(() => navigate({ to: '/login', replace: true }));
    });
  };
}
