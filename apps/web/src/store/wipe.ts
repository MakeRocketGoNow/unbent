import { closeLocalStore } from './db.js';
import { closeLibrary, currentLibraryUser } from './library.js';
import { filesDirName, isFilesDir, isOutbox, isStoreFile, outboxName, searchFileName, storeFileName } from './names.js';

/**
 * Removes every account's local copy, outbox and files from this device — or every
 * account's but one, who is signing in and keeps their own.
 *
 * Called from `clearOfflineCaches`, which the sign-out, the deleted account and the
 * hand-over to a different person call: the local store is the same kind of thing as the
 * service worker's caches — one account's notes, kept on a device for reading with no
 * connection — and goes at the same moments. Every file with the prefix rather than the one
 * account's, because the id of the person leaving is not always known, and a stale copy of
 * someone else's is exactly what this exists to prevent. The exception is named by id: the
 * person arriving keeps the copy and the outbox under their own name, so edits they made
 * offline before a refused session are still there to replay (see `offline-cache.ts`) —
 * and their files directory (`store/files.ts`), which holds the bytes of the uploads in
 * that outbox and of the notebooks they chose to keep. Their search index stays with the
 * copy it indexes.
 *
 * The store is closed first: the engine holds the file through sync access handles, and
 * OPFS refuses to remove a file something holds. Closing the library closes its search
 * index with it. Not when the open one is the kept one.
 * Never throws — a browser without OPFS or IndexedDB has nothing to remove.
 */
export async function wipeLocalStores(except?: string): Promise<void> {
  const keep = except === undefined ? null : { stores: [storeFileName(except), searchFileName(except)], outbox: outboxName(except), files: filesDirName(except) };
  closeLibrariesInOtherTabs();
  if (!keep || currentLibraryUser() !== except) await closeLocalStores();
  /*
   * The other tabs' closes race this: told, each one is still stopping its search sync,
   * its outbox and its engine before it lets go of the file. The outbox's delete waits
   * for their connections on its own (`wipeOutboxes`); the store's file does not — OPFS
   * refuses to remove a file a worker still holds, and the refusal is swallowed — so it
   * is tried again a few times after the outbox deletes have settled, which is usually
   * after the other tabs have closed. Bounded: a tab that will not let go leaves the
   * file for the next wipe, as it did before the other tabs were told at all.
   */
  await wipeOutboxes(keep?.outbox);
  for (let attempt = 0; ; attempt += 1) {
    if (await wipeStoreFiles(keep?.stores, keep?.files)) return;
    if (attempt >= STORE_FILE_RETRIES) return;
    await new Promise((resolve) => setTimeout(resolve, STORE_FILE_RETRY_MS));
  }
}

/** How often, and how long apart, the store's files are tried again while another tab lets go. */
const STORE_FILE_RETRIES = 3;
const STORE_FILE_RETRY_MS = 500;

/**
 * The channel on which a tab wiping this device tells every other tab of the origin to
 * let go of its library first.
 *
 * A library is held by more than the tab that signed out. Every tab the account was open
 * in holds the store's file through its worker, a connection to the outbox's IndexedDB
 * database, and — for one of them — the leadership of each collection, through which the
 * others' writes go. None of that went away when the account did: a tab signed out from
 * underneath bounced to the sign-in screen and kept the lot, and the wipe below then ran
 * against it. The outbox's `deleteDatabase` waited on a connection the other tab never
 * closed, and because IndexedDB serves the requests on one name in order, the next
 * sign-in's open of the same database queued behind that delete, for good: the app sat
 * on "Opening your notes…" in every tab until all of them were closed (seen with three
 * tabs open, 2026-10-10). Told, the other tabs close their libraries, which releases the
 * file, the connection and the leadership — in their own time; `wipeLocalStores` says
 * what waits for that and what is tried again.
 *
 * Every other tab closes whatever it holds, whoever it is for: the wipe that keeps one
 * account's copy (`except`) is a different person signing in, and the tab still signed in
 * as the kept account reopens its library on its next navigation (`acquireLibrary` in the
 * root `beforeLoad`), reading the server meanwhile. A browser without the channel has
 * nothing to tell; the delete's own bounded wait is what it had before.
 */
const CHANNEL = 'unbent-libraries';

function closeLibrariesInOtherTabs(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: 'close' });
    channel.close();
  } catch {
    // Nothing to tell.
  }
}

/**
 * Hears another tab's wipe, and closes this tab's library and store for it, keeping every
 * file: what `closeLocalStores` does for a refused session, for the same reason — this tab
 * decides nothing about the account; the one wiping has. Installed once, at start.
 */
export function installLibraryCloser(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type === 'close') void closeLocalStores();
  };
  return () => channel.close();
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

/** Removes what it can; true when nothing is left that should have gone. */
async function wipeStoreFiles(keep: string[] = [], keepFiles?: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return true;
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    // The kept account's databases — its library and its search index, which holds the text
    // of the files it keeps offline — and the journal and WAL files SQLite writes beside each.
    for await (const [name] of root.entries()) if (isStoreFile(name) && !keep.some((k) => name.startsWith(k))) names.push(name);
    const dirs: string[] = [];
    for await (const [name] of root.entries()) if (isFilesDir(name) && name !== keepFiles) dirs.push(name);
    const outcomes = await Promise.all([
      ...names.map((name) => root.removeEntry(name).then(() => true, () => false)),
      ...dirs.map((name) => root.removeEntry(name, { recursive: true }).then(() => true, () => false)),
    ]);
    return outcomes.every(Boolean);
  } catch {
    // No OPFS, or it is unavailable in this context (a private window, say).
    return true;
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
