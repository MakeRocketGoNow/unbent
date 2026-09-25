import { extractPdfText } from '@unbent/enex';
import { ApiError, httpErrorMessage } from './notes-api.js';

/**
 * Extracting attachment text for search, wherever that happens to run.
 *
 * pdf.js lives in the browser, so extraction does too — Maintenance's button, the
 * pass the app makes on open, the editor after an upload, and the page the Android app
 * hosts all need the same loop and the same two calls. This module is that loop, written
 * against nothing but `fetch`, so it runs in a Web Worker and on a page's own thread alike.
 * What differs per host is only where the progress goes.
 */

export interface IndexProgress {
  /** Files attempted, whatever the outcome. */
  done: number;
  /** Files whose text is now in the index. */
  indexed: number;
  /** Files that were read and held nothing worth indexing. */
  unusable: number;
  /** Files that could not be fetched or read. They stay pending for a later pass. */
  failed: number;
  /** Files pending when the pass began; zero until the first answer arrives. */
  total: number;
}

export interface IndexResult extends IndexProgress {
  /**
   * Set when an unasked pass declined to start: this many files were pending, more than
   * it will pull without being asked. See `AUTO_INDEX_LIMIT`.
   */
  deferred?: number;
}

/**
 * The most an unasked pass will download.
 *
 * The pass on open pulls the same bytes the button does, and a backlog from before PDF
 * search existed is thousands of scans — gigabytes that must not start flowing because a
 * tab was opened on a phone. One page of the pending list is the line between "a few
 * captures since last time" and "a backlog someone should choose to run".
 */
export const AUTO_INDEX_LIMIT = 25;

/**
 * `fetch` with the session, failing on a non-2xx status.
 *
 * `credentials: 'include'` because a worker shares the document's cookie jar but does not
 * send from it by default. The failure carries the status as a number so a host can tell
 * a lost session from a lost file.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
  return res;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Extracts one file's text from bytes already in hand and records the outcome.
 *
 * Both outcomes are written. `unusable: true` records that extraction was tried and yielded
 * nothing worth indexing: without that row the same failing scans would reappear on every
 * pass and a pass would never end. The server stores it empty, so it can never match.
 */
export async function indexFileBytes(
  noteId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<'indexed' | 'unusable'> {
  const extracted = await extractPdfText(bytes);
  const url = `/api/notes/${noteId}/files/${encodeURIComponent(filename)}/text`;
  const usable = extracted.quality.usable;
  await apiFetch(url, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(usable ? { text: extracted.text } : { unusable: true }),
  });
  return usable ? 'indexed' : 'unusable';
}

export interface IndexOptions {
  /** Only this note's files. The phone asks this way; the desktop leaves it unset. */
  note?: string;
  /** An unasked pass, which stops short of a backlog. */
  auto?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Extracts text for every attachment that does not have it yet.
 *
 * Needed because import is idempotent on content hash: notes imported before extraction
 * existed cannot be fixed by re-importing, since they are skipped along with their
 * attachments. This walks the gap instead — and, since the editor and the phone both
 * upload without extracting, it is also what catches anything they missed.
 *
 * Each file is fetched back from the server: this is the pass for files whose bytes are
 * not in hand. A caller that has them uses `indexFileBytes` directly.
 */
export async function indexPendingFiles(opts: IndexOptions = {}): Promise<IndexResult> {
  const progress: IndexProgress = { done: 0, indexed: 0, unusable: 0, failed: 0, total: 0 };
  const query = `limit=25${opts.note ? `&note=${encodeURIComponent(opts.note)}` : ''}`;
  const { signal } = opts;

  /**
   * A file that fails stays pending, so the server offers it again on the next page. It is
   * skipped from then on, and a page made only of skipped files ends the pass — otherwise
   * one unreadable file at the head of the list would be fetched forever.
   */
  const failed = new Set<string>();

  for (;;) {
    if (signal?.aborted) break;

    // The count only until one has been had: it is read from the first page alone, and
    // the server reads a row per unread PDF to produce it. See the route.
    const counted = progress.total === 0;
    const res = await apiFetch(
      `/api/attachments/pending-text?${query}${counted ? '' : '&count=0'}`,
      { method: 'GET', signal },
    );
    const { pending, remaining = 0 } = (await res.json()) as {
      pending: Array<{ noteId: string; filename: string }>;
      remaining?: number;
    };

    if (counted) {
      progress.total = remaining;
      if (opts.auto && remaining > AUTO_INDEX_LIMIT) return { ...progress, deferred: remaining };
    }
    if (pending.length === 0) break;

    let advanced = false;
    for (const item of pending) {
      if (signal?.aborted) break;
      const key = `${item.noteId}/${item.filename}`;
      if (failed.has(key)) continue;
      advanced = true;

      try {
        const blob = await apiFetch(
          `/api/notes/${item.noteId}/files/${encodeURIComponent(item.filename)}`,
          { method: 'GET', signal },
        );
        const bytes = new Uint8Array(await blob.arrayBuffer());
        progress[await indexFileBytes(item.noteId, item.filename, bytes)] += 1;
      } catch {
        if (signal?.aborted) break;
        // A single unreadable file must not stop the pass.
        failed.add(key);
        progress.failed += 1;
      }

      progress.done += 1;
      opts.onProgress?.({ ...progress });
    }
    if (!advanced) break;
  }

  return { ...progress };
}
