import { filesDirName, isFilesDir } from './names.js';

/**
 * File bytes this device holds for an account, in the origin-private file system beside
 * the account's database: the rows were already local (`attachments`), and this is where
 * the bytes behind some of them are.
 *
 * Two shelves, because two different promises:
 *
 *   kept/     the files of the notebooks someone chose to keep on this device
 *             (`store/keep.ts`). Present until the choice is taken back.
 *   pending/  files added here that the server has not taken yet. The outbox entry for
 *             each upload names its file; the bytes cannot live in the entry, which is a
 *             row in IndexedDB. Present until the upload goes through or is refused.
 *
 * Under each, a directory per note and the file under its own name — the two things a
 * file's address carries (`/api/notes/<id>/files/<name>`), so the service worker can
 * answer a request for one from the address alone (`findFile`), with no index to keep in
 * step and no way to ask the database, which lives in another worker.
 *
 * What someone merely opened is not here: that is the service worker's `files-v1` cache,
 * with a budget and an eviction rule (`sw/budget.ts`). The split is by who decided. A
 * copy made by looking is cheap to lose and goes whenever the account on the device
 * changes; these are the account's own, named by its id (`names.ts`), and go only when
 * the local store does (`wipe.ts`) — so a session refused after a week offline still has
 * its kept notebooks and its waiting uploads when the person signs back in.
 *
 * Imported by the page and by the service worker, so nothing here may touch `window`,
 * the collections or the connectivity store.
 */
export type Shelf = 'kept' | 'pending';

/**
 * Whether this browser can hold files this way: the file system, and a way to write to it
 * off a dedicated worker. Safari had only the synchronous handles for years, which a page
 * and a service worker cannot open; there, nothing is kept and a file added offline is
 * refused as it was before, which is the app as it was.
 */
export function filesSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function'
  );
}

/**
 * A file's name on the shelf. Its own, which the upload route has already held to what a
 * file system takes — no separators, not `.` or `..` — except when it is long: the route
 * allows 768 characters and a file system's limit is usually 255 bytes, so a long name is
 * cut and given a hash of the whole of it. Synchronous on purpose; the worker computes
 * this on every request for a file.
 */
export function shelfName(filename: string): string {
  if (filename.length <= 100) return filename;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < filename.length; i += 1) {
    const ch = filename.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  return `${filename.slice(0, 60)}~${hash}`;
}

const missing = (err: unknown) => (err as { name?: string } | null)?.name === 'NotFoundError';

async function noteDir(account: FileSystemDirectoryHandle, shelf: Shelf, noteId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const on = await account.getDirectoryHandle(shelf, { create });
    return await on.getDirectoryHandle(noteId, { create });
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

async function accountDir(userId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(filesDirName(userId), { create });
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/**
 * Puts a file on a shelf, whole or not at all: `createWritable` writes to a copy and
 * swaps it in on `close`, so a tab closed mid-write leaves the shelf as it was rather
 * than a truncated PDF the worker would then serve as the real one.
 */
export async function writeFile(userId: string, shelf: Shelf, noteId: string, filename: string, data: Blob | ReadableStream<Uint8Array>): Promise<void> {
  const account = await accountDir(userId, true);
  const dir = account && (await noteDir(account, shelf, noteId, true));
  if (!dir) throw new Error('No file system to keep the file in');
  const handle = await dir.getFileHandle(shelfName(filename), { create: true });
  const writable = await handle.createWritable();
  try {
    if (data instanceof Blob) await writable.write(data);
    else await data.pipeTo(writable, { preventClose: true });
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

async function fileIn(account: FileSystemDirectoryHandle, shelf: Shelf, noteId: string, filename: string): Promise<File | null> {
  try {
    const dir = await noteDir(account, shelf, noteId, false);
    if (!dir) return null;
    return await (await dir.getFileHandle(shelfName(filename))).getFile();
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

export async function readFile(userId: string, shelf: Shelf, noteId: string, filename: string): Promise<File | null> {
  const account = await accountDir(userId, false);
  return account ? fileIn(account, shelf, noteId, filename) : null;
}

/** Takes a file off a shelf, and its note's directory with it once that is empty. Never throws for a file that is not there. */
export async function removeFile(userId: string, shelf: Shelf, noteId: string, filename: string): Promise<void> {
  try {
    const account = await accountDir(userId, false);
    const on = account && (await account.getDirectoryHandle(shelf));
    const dir = on && (await on.getDirectoryHandle(noteId));
    if (!on || !dir) return;
    await dir.removeEntry(shelfName(filename));
    for await (const _ of dir.keys()) return;
    await on.removeEntry(noteId);
  } catch (err) {
    if (!missing(err)) throw err;
  }
}

export interface ShelvedFile {
  noteId: string;
  /** The name on the shelf: the file's own, or `shelfName`'s cut of a long one. */
  name: string;
  size: number;
}

/** Everything on a shelf, with sizes: what the keeper reconciles against and Settings adds up. */
export async function listShelf(userId: string, shelf: Shelf): Promise<ShelvedFile[]> {
  const out: ShelvedFile[] = [];
  try {
    const account = await accountDir(userId, false);
    if (!account) return out;
    const on = await account.getDirectoryHandle(shelf);
    for await (const [noteId, dir] of on.entries()) {
      if (dir.kind !== 'directory') continue;
      for await (const [name, handle] of (dir as FileSystemDirectoryHandle).entries()) {
        if (handle.kind !== 'file') continue;
        out.push({ noteId, name, size: (await (handle as FileSystemFileHandle).getFile()).size });
      }
    }
  } catch (err) {
    if (!missing(err)) throw err;
  }
  return out;
}

/** Empties a shelf. What "remove kept files" in Settings does, and nothing else: `pending` is the outbox's. */
export async function clearShelf(userId: string, shelf: Shelf): Promise<void> {
  try {
    const account = await accountDir(userId, false);
    await account?.removeEntry(shelf, { recursive: true });
  } catch (err) {
    if (!missing(err)) throw err;
  }
}

/**
 * The bytes for a file's address, from whichever account's directory holds them: what
 * the service worker asks before it asks its cache or the network.
 *
 * The worker does not know who is signed in — a request for a picture carries no account
 * — so it looks in every directory. That is one, in practice: sign-out removes them all,
 * and someone else signing in removes all but their own (`wipe.ts`). A refused session's
 * directory does outlive the session, until the next sign-in, and a note id is a random
 * UUID nobody else holds; the worst a stale directory can do is draw a picture for
 * someone who already had its address. `pending` first: a file waiting to upload is the
 * newer truth about its name.
 */
export async function findFile(noteId: string, filename: string): Promise<File | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return null;
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (!isFilesDir(name) || handle.kind !== 'directory') continue;
      for (const shelf of ['pending', 'kept'] as const) {
        const file = await fileIn(handle as FileSystemDirectoryHandle, shelf, noteId, filename);
        if (file) return file;
      }
    }
  } catch {
    // No file system in this context, or it is busy; the cache and the network still answer.
  }
  return null;
}

const KEPT_LIST = 'kept.json';

/**
 * The notebooks this device keeps, by id. A file in the account's directory rather than a
 * row in the database or a key in `localStorage`: it is this device's choice, not the
 * account's, so it must not sync; and it has to go when the files do, which being in
 * their directory makes true by construction.
 */
export async function readKeptNotebooks(userId: string): Promise<string[]> {
  try {
    const account = await accountDir(userId, false);
    if (!account) return [];
    const text = await (await (await account.getFileHandle(KEPT_LIST)).getFile()).text();
    const ids: unknown = JSON.parse(text);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function writeKeptNotebooks(userId: string, ids: string[]): Promise<void> {
  const account = await accountDir(userId, true);
  if (!account) throw new Error('No file system to keep the list in');
  const writable = await (await account.getFileHandle(KEPT_LIST, { create: true })).createWritable();
  await writable.write(JSON.stringify(ids));
  await writable.close();
}
