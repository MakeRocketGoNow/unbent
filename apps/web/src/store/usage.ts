/**
 * How much this site has stored on the device, for Settings → Offline to say: the browser's
 * own estimate, with its figure for the origin-private file system replaced by the sizes of
 * the files that are actually there.
 *
 * Chrome's count of that file system can be wrong by gigabytes. On 2026-11-12 a desktop
 * install was told "Unbent is using 3.98 GB": `estimate()` put 4,245 MB under
 * `usageDetails.fileSystem`, while the files in it (the library, the search index and
 * SQLite's scratch directories) came to 31 MB, and the origin's folder in the profile held
 * 34 MB on disk. The counter Chrome keeps beside that folder (`File System/<n>/t/.usage` in
 * the profile) read minus 82 MB, marked valid, and the figure reported was that wrapped
 * round 2^32 plus the files: 4,295 - 82 + 33 = 4,246. A restart kept it; deleting the file
 * with Chrome closed made Chrome measure the folder again (31 MB). Nothing the app writes
 * can set that counter: it is Chrome's bookkeeping of the writes SQLite makes through
 * access handles, all day, in small pieces, and one day it took away more than it added. The other parts of the
 * estimate (the worker's caches, IndexedDB) matched what was stored, so only the file
 * system's part is replaced, and only where the browser reports the parts at all. Firefox
 * and Safari give a total alone, which is then said as it is.
 *
 * This is for saying what Unbent keeps, and nothing else. What decides whether a notebook
 * fits or a file can wait to upload (`useDeviceRoom`, `keep.ts`, `actions.ts`) stays on the
 * browser's estimate, since that is the figure the browser holds this site to: a corrected
 * number there would promise room the browser may then refuse.
 *
 * A file the walk cannot read (one SQLite holds open at that moment, on a browser that will
 * not size it then) makes the whole measure unknown, and the answer is null rather than the
 * estimate: a total that leaves out the library would be a smaller wrong number, and the
 * estimate is the number this exists to stop saying, so the caller keeps the last measure
 * it had. The library's writes come in short transactions, and wa-sqlite's cooperative VFS
 * lets a file go between them, so a walk mostly finds every file free: on 2026-11-12 one ran
 * in Chrome beside a window holding the library open, and sized all of them.
 */
export async function storedBytes(): Promise<number | null> {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (!estimate || estimate.usage === undefined) return null;
  const counted = (estimate as StorageEstimate & { usageDetails?: Record<string, number> }).usageDetails?.fileSystem;
  if (counted === undefined) return estimate.usage;
  const measured = await fileSystemBytes().catch(() => null);
  if (measured === null) return null;
  return Math.max(0, estimate.usage - counted + measured);
}

/**
 * The size of every file in the origin-private file system, directories walked. The whole
 * origin's, not only the account's: everything there was put there by this app (the
 * library, its search index, the shelves of kept and waiting files, wa-sqlite's scratch
 * directories), and it is the whole origin's figure being replaced.
 */
async function fileSystemBytes(): Promise<number> {
  return directoryBytes(await navigator.storage.getDirectory());
}

async function directoryBytes(dir: FileSystemDirectoryHandle): Promise<number> {
  let bytes = 0;
  for await (const [, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    bytes += handle.kind === 'file' ? (await (handle as FileSystemFileHandle).getFile()).size : await directoryBytes(handle as FileSystemDirectoryHandle);
  }
  return bytes;
}
