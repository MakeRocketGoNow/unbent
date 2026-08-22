/// <reference lib="webworker" />
import { importEnex, type ImportFailure, type ImportProgress } from '@unbent/enex';

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

export type ImportRequest = { type: 'start'; file: File } | { type: 'abort' };

export type ImportEvent =
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

  const { file } = event.data;
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

        updateBody: async (noteId, body) => {
          await api(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          });
        },
      },
      {
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
