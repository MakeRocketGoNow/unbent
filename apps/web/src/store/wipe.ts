import { closeLocalStore } from './db.js';
import { closeLibrary, currentLibraryUser } from './library.js';
import { isOutbox, isStoreFile, outboxName, storeFileName } from './names.js';

/**
 * Removes every account's local copy and outbox from this device — or every account's
 * but one, who is signing in and keeps their own.
 *
 * Called from `clearOfflineCaches`, which the sign-out, the deleted account and the
 * hand-over to a different person call: the local store is the same kind of thing as the
 * service worker's caches — one account's notes, kept on a device for reading with no
 * connection — and goes at the same moments. Every file with the prefix rather than the one
 * account's, because the id of the person leaving is not always known, and a stale copy of
 * someone else's is exactly what this exists to prevent. The exception is named by id: the
 * person arriving keeps the copy and the outbox under their own name, so edits they made
 * offline before a refused session are still there to replay (see `offline-cache.ts`).
 *
 * The store is closed first: the engine holds the file through sync access handles, and
 * OPFS refuses to remove a file something holds. Not when the open one is the kept one.
 * Never throws — a browser without OPFS or IndexedDB has nothing to remove.
 */
export async function wipeLocalStores(except?: string): Promise<void> {
  const keep = except === undefined ? null : { file: storeFileName(except), outbox: outboxName(except) };
  if (!keep || currentLibraryUser() !== except) await closeLocalStores();
  await Promise.all([wipeStoreFiles(keep?.file), wipeOutboxes(keep?.outbox)]);
}

/** Closes the open library and its store, keeping every file: what a refused session does. */
export async function closeLocalStores(): Promise<void> {
  try {
    await closeLibrary();
    await closeLocalStore();
  } catch {
    // Closing can fail if the worker is already gone; a removal that follows still applies.
  }
}

async function wipeStoreFiles(keep?: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    // The kept account's database and the journal and WAL files SQLite writes beside it.
    for await (const [name] of root.entries()) if (isStoreFile(name) && !(keep && name.startsWith(keep))) names.push(name);
    await Promise.all(names.map((name) => root.removeEntry(name).catch(() => {})));
  } catch {
    // No OPFS, or it is unavailable in this context (a private window, say).
  }
}

async function wipeOutboxes(keep?: string): Promise<void> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return;
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs
        .map((d) => d.name)
        .filter((name): name is string => !!name && isOutbox(name) && name !== keep)
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = req.onerror = () => resolve();
              // Blocked means a connection is still open; the delete completes when it
              // closes, which `closeLibrary` above has arranged. Waited for, bounded.
              req.onblocked = () => setTimeout(resolve, 2000);
            }),
        ),
    );
  } catch {
    // Nothing to remove.
  }
}
