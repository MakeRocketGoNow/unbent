import { closeLocalStore } from './db.js';
import { isOutbox, isStoreFile } from './names.js';

/**
 * Removes every account's local copy and outbox from this device.
 *
 * Called from `clearOfflineCaches`, which the sign-out, the refused session, the deleted
 * account and the hand-over to a different person already call: the local store is the
 * same kind of thing as the service worker's caches — one account's notes, kept on a
 * device for reading with no connection — and goes at the same moments. Every file with
 * the prefix rather than the one account's, because the id of the person leaving is not
 * always known (a session the server refused is a sign-out of nobody in particular), and
 * a stale copy of someone else's is exactly what this exists to prevent.
 *
 * The store is closed first: the engine holds the file through sync access handles, and
 * OPFS refuses to remove a file something holds. Never throws — a browser without OPFS
 * or IndexedDB has nothing to remove.
 */
export async function wipeLocalStores(): Promise<void> {
  try {
    await closeLocalStore();
  } catch {
    // Closing can fail if the worker is already gone; the removal below still applies.
  }
  await Promise.all([wipeStoreFiles(), wipeOutboxes()]);
}

async function wipeStoreFiles(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const [name] of root.entries()) if (isStoreFile(name)) names.push(name);
    await Promise.all(names.map((name) => root.removeEntry(name).catch(() => {})));
  } catch {
    // No OPFS, or it is unavailable in this context (a private window, say).
  }
}

async function wipeOutboxes(): Promise<void> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return;
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs
        .map((d) => d.name)
        .filter((name): name is string => !!name && isOutbox(name))
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            }),
        ),
    );
  } catch {
    // Nothing to remove.
  }
}
