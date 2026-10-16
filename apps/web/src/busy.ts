import { getImportRun } from './import-run.js';
import { fileNotesWaiting, getFileNotes } from './file-notes.js';
import { isExportRunning } from './export-archive.js';
import { indexing } from './index-files.js';

/**
 * Whether this page is in the middle of something a full reload would lose.
 *
 * Asked by the update notice's Reload before it reloads into a newer build — see
 * `sw-register.ts`, which waits for this to clear rather than refusing. A reload must not
 * land while a note has typing the autosave has not sent, a file is uploading, or an
 * import, export, indexing pass or batch of notes made from files is running, since
 * each of those lives in this page and nowhere else.
 *
 * The background runs are read from their own stores, which already know. The
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
    // Files becoming notes: a reload mid-batch loses every file not yet handed to the
    // outbox, and a note already made and linking to it stays. Files handed over on the
    // login screen are held in memory until someone signs in, and are lost the same way.
    getFileNotes().status === 'running' ||
    fileNotesWaiting() ||
    isExportRunning() ||
    indexing.get().status === 'running'
  );
}
