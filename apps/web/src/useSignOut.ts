import { useSyncExternalStore } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { signOut, refreshSession } from './auth-client.js';
import { isHosted, postToApp } from './app-bridge.js';
import { forgetSession } from './session-memory.js';
import { clearOfflineCaches } from './offline-cache.js';
import { claimImportFor } from './import-run.js';
import { settleWrites, subscribeWrites } from './store/library.js';

/**
 * Changes the server has not taken, when Sign out was pressed and the outbox did not
 * drain in time — put to the person before the wipe takes them. In a store beside the
 * failure below, for the same reason: the menu that was pressed has closed, so the
 * question is asked by `SignOutConfirm` in the shell, with the count, and the answer
 * comes back here.
 */
export interface UnsyncedQuestion {
  count: number;
  /** Leave anyway, and lose them. */
  leave: () => void;
  /** Stay signed in; the outbox keeps trying. */
  stay: () => void;
}
let unsynced: UnsyncedQuestion | null = null;
const unsyncedListeners = new Set<() => void>();

function setUnsynced(next: UnsyncedQuestion | null): void {
  unsynced = next;
  for (const listener of unsyncedListeners) listener();
}

export function useUnsyncedQuestion(): UnsyncedQuestion | null {
  return useSyncExternalStore(
    (listener) => {
      unsyncedListeners.add(listener);
      return () => {
        unsyncedListeners.delete(listener);
      };
    },
    () => unsynced,
    () => null,
  );
}

/**
 * Asks whether to leave with `count` changes unsynced; resolves with the answer. The
 * question follows the outbox while it is up: when the count reaches nothing the warning
 * is no longer true, so the question comes down and the sign-out goes on — and the count
 * it shows is the current one until then. A second press of Sign out while a question is
 * up answers the first one with "stay" rather than leaving its chain hanging.
 */
function askToLeave(count: number): Promise<boolean> {
  unsynced?.stay();
  return new Promise((resolve) => {
    let stop = () => {};
    const answer = (leave: boolean) => {
      stop();
      setUnsynced(null);
      resolve(leave);
    };
    const ask = (n: number) => setUnsynced({ count: n, leave: () => answer(true), stay: () => answer(false) });
    ask(count);
    stop = subscribeWrites((pending) => {
      if (!unsynced) return;
      if (pending === 0) answer(true);
      else if (pending !== unsynced.count) ask(pending);
    });
  });
}

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
/**
 * A sign-out the server did not confirm, in a browser — shown by `SignOutSnackbar`, once,
 * in the shell. The menu that was pressed has closed by then, so without it the press
 * would simply do nothing.
 */
let failed = false;
const failListeners = new Set<() => void>();

function setFailed(next: boolean): void {
  if (next === failed) return;
  failed = next;
  for (const listener of failListeners) listener();
}

export function useSignOutFailed(): { failed: boolean; dismiss: () => void } {
  const current = useSyncExternalStore(
    (listener) => {
      failListeners.add(listener);
      return () => {
        failListeners.delete(listener);
      };
    },
    () => failed,
    () => false,
  );
  return { failed: current, dismiss: () => setFailed(false) };
}

export function useSignOut(): () => void {
  const navigate = useNavigate();
  return () => {
    setFailed(false);
    /*
       Writes still waiting in the outbox go first, for a few seconds at most: the wipe
       below removes the outbox with them, and the menu offers Sign out only with a
       connection, so what waits is mid-replay and usually gone in a moment. What is still
       waiting after that — the server having a bad minute — is put to the person with the
       count, since the wipe would take it (`SignOutConfirm`); staying is the safe answer
       and the outbox keeps trying.
    */
    void settleWrites(5000)
      .then(async (left) => {
        if (left > 0 && !(await askToLeave(left))) return 'stayed';
        return signOut();
      })
      .then((res) => (res === 'stayed' ? 'stayed' : !res?.error), () => false)
      .then(async (ended) => {
        if (ended === 'stayed') return;
        /*
         * In a browser, a sign-out the server did not hear has not happened: the session
         * cookie is HttpOnly and only the server can end it, so clearing this page would
         * be undone by the next load. Nothing is touched, and nothing is reported as a
         * crash, but it is said (`SignOutSnackbar`). The menu offers Sign out only with a
         * connection there (`AccountMenu`), so this is the rare failure online. The Android app goes on below: it clears its
         * own cookies when told, which completes the sign-out on the device either way.
         */
        if (!ended && !isHosted()) {
          setFailed(true);
          return;
        }
        // Before anything that can return early: whoever this device remembers as signed
        // in (`session-memory.ts`), and the copies of their notes kept for reading offline
        // (`offline-cache.ts`), must not outlive a sign-out — or the next time the app
        // opened with no connection it would carry on as them. Awaited, so they are gone
        // before the page moves on.
        //
        // A running import is the same kind of leftover, and worse: its worker sends
        // whatever cookie the page holds, so the next person to sign in here would get
        // its notes. The shell drops it too when the session store empties, but inside
        // the Android app the store is never refreshed (below), so that never happens.
        // See `ImportRun.claim`.
        forgetSession();
        claimImportFor(undefined);
        await clearOfflineCaches();
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
        await refreshSession().catch(() => null);
        await navigate({ to: '/login', replace: true });
      });
  };
}
