import { API_CACHE, FILES_CACHE } from './sw/routes.js';
import { wipeLocalStores } from './store/wipe.js';

/**
 * Empties what this device keeps of one account's notes and files: the service worker's
 * caches, and the local copy of the library with its outbox (`store/wipe.ts`).
 *
 * Those copies are what lets the app open offline, and they must go whenever the account
 * on this device changes hands: on signing out, on a session the server refuses, on
 * deleting the account, and when a different person signs in. Otherwise the next person
 * to open the app with no connection would be shown the last one's notes. The worker's
 * caches are keyed by address — `/api/notes/<id>` is the same address whoever is signed
 * in — and the local store by account, but both go: the id of the person leaving is not
 * always known.
 *
 * The shell's own precache is left alone; it is the app, not anybody's data. Never throws:
 * a browser without Cache Storage or OPFS has nothing to empty.
 */
export async function clearOfflineCaches(): Promise<void> {
  await Promise.all([
    typeof caches === 'undefined'
      ? Promise.resolve()
      : Promise.all([caches.delete(API_CACHE), caches.delete(FILES_CACHE)]).catch(() => {}),
    wipeLocalStores(),
  ]);
}
