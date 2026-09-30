import { API_CACHE, FILES_CACHE } from './sw/routes.js';

/**
 * Empties what the service worker kept of one account's notes and files.
 *
 * Those copies are what lets the app open offline, and they are keyed by address, not by
 * who asked — `/api/notes/<id>` is the same address whoever is signed in. So they have to
 * go whenever the account on this device changes hands: on signing out, on a session the
 * server refuses, on deleting the account, and when a different person signs in. Otherwise
 * the next person to open the app with no connection would be shown the last one's notes.
 *
 * The shell's own precache is left alone; it is the app, not anybody's data. Never throws:
 * a browser without Cache Storage has nothing to empty.
 */
export async function clearOfflineCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all([caches.delete(API_CACHE), caches.delete(FILES_CACHE)]).catch(() => {});
}
