import { API_CACHE, FILES_CACHE } from './sw/routes.js';
import { closeLocalStores, wipeLocalStores } from './store/wipe.js';

/**
 * What to do with the local copies of libraries on this device: every account's goes;
 * every account's but one, who is signing in; or none, and only the worker's caches go.
 */
export type StoreWipe = 'all' | { except: string } | 'none';

/**
 * Empties what this device keeps of an account's notes and files: the service worker's
 * caches, and — as asked — the local copy of the library with its outbox (`store/wipe.ts`).
 *
 * The worker's caches are keyed by address — `/api/notes/<id>` is the same address whoever
 * is signed in — so they go every time, cheap to refill. The local store and the outbox
 * are keyed by account, and the outbox holds writes the server has not heard of, so they
 * go only when the account on this device has changed hands for good: on signing out, on
 * deleting the account, and when a different person signs in (`except` the one arriving,
 * whose own copy is kept). A session the server refuses is not that: someone edited
 * offline for longer than their sign-in lasted, reconnected, and got a 401 — wiping then
 * deleted every pending edit without a word before they could sign in again (review of
 * #232). Their store is closed and kept (`'none'`), and their sign-in reopens it and
 * replays what waited.
 *
 * The shell's own precache is left alone; it is the app, not anybody's data. Never throws:
 * a browser without Cache Storage or OPFS has nothing to empty.
 */
export async function clearOfflineCaches(stores: StoreWipe = 'all'): Promise<void> {
  await Promise.all([
    typeof caches === 'undefined'
      ? Promise.resolve()
      : Promise.all([caches.delete(API_CACHE), caches.delete(FILES_CACHE)]).catch(() => {}),
    stores === 'none' ? closeLocalStores() : wipeLocalStores(stores === 'all' ? undefined : stores.except),
  ]);
}
