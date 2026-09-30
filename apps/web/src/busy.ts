import { getImportRun } from './import-run.js';
import { isExportRunning } from './export-archive.js';
import { indexing } from './index-files.js';

/**
 * Whether this page is in the middle of something a full reload would lose.
 *
 * Asked before the app swaps itself for a new deploy on a navigation — see
 * `sw-register.ts`. A reload is otherwise harmless there: the destination was being
 * loaded anyway. What it must not do is land while a note has typing the autosave has not
 * sent, a file is uploading, or an import, export or indexing pass is running, since each
 * of those lives in this page and nowhere else.
 *
 * The three background runs are read from their own stores, which already know. The
 * open note says so itself through `holdPage`, because only it knows its save state and
 * its uploads, and a note is mounted and unmounted far more often than a store changes.
 */
const holds = new Set<object>();

/** Marks the page busy until the returned function is called. */
export function holdPage(): () => void {
  const token = {};
  holds.add(token);
  return () => {
    holds.delete(token);
  };
}

export function pageBusy(): boolean {
  return (
    holds.size > 0 ||
    getImportRun().status === 'running' ||
    isExportRunning() ||
    indexing.get().status === 'running'
  );
}
