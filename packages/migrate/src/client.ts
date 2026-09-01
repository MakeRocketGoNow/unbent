import type { ImportClient } from '@unbent/enex';

/**
 * An ImportClient that talks to a deployed Unbent over a bearer token.
 *
 * The browser's importer implements this same interface against cookies; everything above
 * it — ENML conversion, attachments, hashing, progress, failure collection — is shared, so
 * this file is only the transport.
 */

/** A failed API call, carrying the status so the CLI can explain a 401 differently. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * True if the token is still good.
 *
 * Worth one request before an import starts. importEnex catches per-note errors and
 * records them as failures, so a dead token does not surface as "sign in again" — it
 * surfaces as every note failing with an identical 401, which on a large export is
 * thousands of lines advising a retry that cannot possibly work.
 */
export async function checkToken(baseUrl: string, token: string): Promise<boolean> {
  const res = await fetch(new URL('/api/notes?limit=1', baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status !== 401;
}

export function createClient(baseUrl: string, token: string): ImportClient {
  async function api(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(new URL(path, baseUrl), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ApiError(res.status, `${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return res;
  }

  return {
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
        // Raw bytes rather than base64, which would add a third to every upload.
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
  };
}
