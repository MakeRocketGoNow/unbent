/**
 * Empties each named store file through a sync access handle and then removes it, so that
 * removing it does not drive Chrome's saved count of the origin's file-system usage below
 * zero. Run in a dedicated worker (`shrink-worker.ts`), the only place a sync access handle
 * can be had; `wipeStoreFiles` in `wipe.ts` removes on the page whatever this did not.
 *
 * Why, measured in Chrome 155 and 157 on 2026-11-12: bytes written through a
 * `FileSystemSyncAccessHandle` are counted in memory but never saved to the origin's
 * usage counter, so after a restart Chrome has forgotten them. Removing such a file then
 * subtracts its real size from a counter that never held it, the counter goes negative,
 * and Chrome reports it on the next launch as about 4 GB (2^32 less the deficit). The
 * library and its search index are written entirely through sync access handles (wa-sqlite's
 * `OPFSCoopSyncVFS`), and the wipe on sign-out is the largest removal they see, so every
 * sign-out after a restart took the counter down by the size of the library. Truncating
 * through a handle first is as invisible to the counter as the writes were, and the removal
 * that follows subtracts nothing: the counter stays at what it was. This does not fix the
 * undercount after a restart, which is Chrome's; it only stops the wraparound. It is
 * Chromium issue 436552046 (https://issues.chromium.org/issues/436552046), where the same
 * workaround is given; once that is fixed and the fix has reached stable, this can go.
 *
 * The wrapped figure is not only a wrong number in Settings: where a browser caps a site's
 * quota below it (Brave, at 2 GiB) the origin reads as over quota, and the room checks that
 * ask `estimate()` before writing (Keep offline in `keep.ts`, a file added offline in
 * `actions.ts`) refuse.
 *
 * The cost is the other direction, and it was measured too. When Chrome has no valid saved
 * counter at launch (the first launch after the origin's file system was made, or after a
 * crash) it measures the disk, and then the library's bytes as they were at that moment are
 * counted. Emptied invisibly, they stay counted after the removal: the saved count ends that
 * much high (1.8 MB over, for the demo library) where a plain removal would have been
 * exact. Nothing tells the page which of the two it is in, so the choice is which way to be
 * wrong: high by at most the library's size at the last such measurement, until the next
 * one, or below zero, which Chrome reports as about 4 GB and never corrects.
 *
 * Never truncates a file it does not then remove at once. A handle is exclusive, so a file
 * another tab's engine holds at that moment refuses it and is skipped untouched; the page's
 * plain removal is refused for the same reason and tried again later, as it always was.
 * That is not a promise that an open library is left alone: wa-sqlite's cooperative VFS lets
 * a file go between transactions (`usage.ts` measured it), so an idle library in another
 * tab is usually not holding its file, and is emptied and removed here exactly as
 * `removeEntry` alone removed it before. The wipe tells those tabs to close first
 * (`installLibraryCloser`) for that reason. Between `close` and the removal another engine
 * could take the file back; what it would find is an emptied store that was being wiped
 * anyway, which the wipe's next try removes.
 *
 * A file it cannot empty (no `createSyncAccessHandle` in this browser, or a handle refused)
 * is left for the page, rather than removed here without the truncate: the page's
 * `removeEntry` is the same call, and keeping it there keeps one path for "removed without
 * the fix".
 */

/** The little of the file-system API this needs, typed here: the DOM lib has no sync access handles. */
export type ShrinkHandle = { truncate(size: number): void; flush(): void; close(): void };
export type ShrinkRoot = {
  getFileHandle(name: string): Promise<{ createSyncAccessHandle?: () => Promise<ShrinkHandle> }>;
  removeEntry(name: string): Promise<void>;
};

/** What the worker posts: each file as it goes, then that it has finished. */
export type ShrinkMessage = { removed: string } | { done: true };

/** Empties and removes each file it can, calling `onRemoved` for each one gone. One at a time: they are a few files, and the order is the page's. */
export async function shrinkAndRemove(root: ShrinkRoot, names: string[], onRemoved: (name: string) => void): Promise<void> {
  for (const name of names) {
    try {
      const file = await root.getFileHandle(name);
      if (typeof file.createSyncAccessHandle !== 'function') continue;
      const handle = await file.createSyncAccessHandle();
      try {
        handle.truncate(0);
        handle.flush();
      } finally {
        handle.close();
      }
      await root.removeEntry(name);
      onRemoved(name);
    } catch {
      // Held, gone already, or no handle to be had: the page removes it, or tries again.
    }
  }
}
