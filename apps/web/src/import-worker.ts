/// <reference lib="webworker" />
import {
  extractPdfText,
  importEnex,
  type ImportFailure,
  type ImportProgress,
} from '@unbent/enex';

/**
 * Runs an ENEX import off the main thread.
 *
 * Parsing 3.6GB takes ~70s of solid CPU; on the main thread that is 70 seconds of frozen
 * UI with no progress and no way to cancel. The worker also owns the fetch calls, so
 * uploads do not compete with rendering.
 *
 * Cookies travel with `credentials: 'include'` — a worker shares the document's cookie
 * jar but does not send them by default.
 */

export type ImportRequest =
  | { type: 'start'; file: File; extractText: boolean }
  | { type: 'backfill' }
  | { type: 'abort' };

export type BackfillProgress = { done: number; indexed: number; total: number };

export type ImportEvent =
  | { type: 'backfill-progress'; progress: BackfillProgress }
  | { type: 'backfill-done'; progress: BackfillProgress }
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'failure'; failure: ImportFailure }
  | { type: 'done'; progress: ImportProgress }
  | { type: 'error'; message: string };

const post = (event: ImportEvent) => self.postMessage(event);

let controller: AbortController | null = null;

async function api(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(path, { ...init, credentials: 'include' });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res;
}

self.onmessage = async (event: MessageEvent<ImportRequest>) => {
  if (event.data.type === 'abort') {
    controller?.abort();
    return;
  }

  if (event.data.type === 'backfill') {
    await runBackfill();
    return;
  }

  const { file, extractText } = event.data;
  controller = new AbortController();

  try {
    const progress = await importEnex(
      { name: file.name, stream: () => file.stream() },
      {
        createNote: async (input) => {
          const res = await api('/api/import/note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          });
          return res.json() as Promise<{ id: string; created: boolean }>;
        },

        uploadFile: async (noteId, filename, mime, bytes) => {
          const res = await api(`/api/notes/${noteId}/files`, {
            method: 'PUT',
            headers: {
              'X-Filename': encodeURIComponent(filename),
              'Content-Type': mime,
            },
            // Bytes, not base64: sending the encoded form would add 33% to a multi-GB
            // upload for no benefit.
            body: bytes as unknown as BodyInit,
          });
          return res.json() as Promise<{ filename: string }>;
        },

        listFiles: async (noteId) => {
          const res = await api(`/api/notes/${noteId}/files`, { method: 'GET' });
          const { files } = (await res.json()) as { files: Array<{ filename: string }> };
          return files.map((f) => f.filename);
        },

        updateBody: async (noteId, body) => {
          await api(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          });
        },

        saveFileText: async (noteId, filename, text) => {
          await api(`/api/notes/${noteId}/files/${encodeURIComponent(filename)}/text`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          });
        },
      },
      {
        extractText,
        signal: controller.signal,
        onProgress: (progress) => post({ type: 'progress', progress }),
        onFailure: (failure) => post({ type: 'failure', failure }),
      },
    );

    post({ type: 'done', progress });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  } finally {
    controller = null;
  }
};

/**
 * Extracts text for attachments that do not have it yet.
 *
 * Needed because import is idempotent on content hash: notes imported before extraction
 * existed cannot be fixed by re-importing, since they are skipped along with their
 * attachments. This walks the gap instead.
 */
async function runBackfill(): Promise<void> {
  controller = new AbortController();
  const progress: BackfillProgress = { done: 0, indexed: 0, total: 0 };

  try {
    for (;;) {
      if (controller.signal.aborted) break;

      const res = await api('/api/attachments/pending-text?limit=25', { method: 'GET' });
      const { pending, remaining } = (await res.json()) as {
        pending: Array<{ noteId: string; filename: string }>;
        remaining: number;
      };

      if (progress.total === 0) progress.total = remaining;
      if (pending.length === 0) break;

      for (const item of pending) {
        if (controller.signal.aborted) break;

        try {
          const blob = await api(
            `/api/notes/${item.noteId}/files/${encodeURIComponent(item.filename)}`,
            { method: 'GET' },
          );
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const extracted = await extractPdfText(bytes);

          if (extracted.quality.usable) {
            await api(
              `/api/notes/${item.noteId}/files/${encodeURIComponent(item.filename)}/text`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: extracted.text }),
              },
            );
            progress.indexed += 1;
          } else {
            /**
             * Record that extraction was tried and yielded nothing usable.
             *
             * Without this the same failing scans reappear on every pass and the backfill
             * never terminates. The server stores an empty row, so it can never match.
             */
            await api(
              `/api/notes/${item.noteId}/files/${encodeURIComponent(item.filename)}/text`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ unusable: true }),
              },
            );
          }
        } catch {
          // A single unreadable file must not stop the pass.
        }

        progress.done += 1;
        post({ type: 'backfill-progress', progress: { ...progress } });
      }
    }

    post({ type: 'backfill-done', progress });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  } finally {
    controller = null;
  }
}
