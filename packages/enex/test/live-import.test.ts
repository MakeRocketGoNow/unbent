/**
 * End-to-end import against a running dev server and a real .enex file.
 *
 * Skipped unless ENEX_DIR and LIVE_IMPORT are set, so the normal suite stays hermetic.
 */
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { importEnex, type ImportClient } from '../src/import.js';

const DIR = process.env['ENEX_DIR'];
const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';
const enabled = process.env['LIVE_IMPORT'] === '1' && DIR !== undefined && existsSync(DIR);

async function signUp(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      email: `import-${Date.now()}@example.test`,
      password: 'import-password-123',
      name: 'Importer',
    }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function liveClient(cookie: string): ImportClient {
  const headers = { Cookie: cookie, Origin: ORIGIN };
  return {
    createNote: async (input) => {
      const res = await fetch(`${BASE}/api/import/note`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json() as Promise<{ id: string; created: boolean }>;
    },
    uploadFile: async (noteId, filename, mime, bytes) => {
      const res = await fetch(`${BASE}/api/notes/${noteId}/files`, {
        method: 'PUT',
        headers: { ...headers, 'X-Filename': encodeURIComponent(filename), 'Content-Type': mime },
        body: bytes,
      });
      if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
      return res.json() as Promise<{ filename: string }>;
    },
    updateBody: async (noteId, body) => {
      const res = await fetch(`${BASE}/api/notes/${noteId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`patch ${res.status}`);
    },
  };
}

function fileHandle(name: string) {
  return {
    name,
    stream: () =>
      Readable.toWeb(createReadStream(`${DIR}/${name}`)) as ReadableStream<Uint8Array>,
  };
}

describe.skipIf(!enabled)('live import', () => {
  it('imports a small notebook and makes it searchable', async () => {
    const cookie = await signUp();
    const client = liveClient(cookie);

    const progress = await importEnex(fileHandle('Quotes.enex'), client);

    expect(progress.created).toBe(16);
    expect(progress.failed).toBe(0);

    const { items } = await fetch(`${BASE}/api/notes?limit=100`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(items).toHaveLength(16);

    // The notebook name became a tag on every note.
    expect(items.every((n: { tags: string[] }) => n.tags.includes('Quotes'))).toBe(true);

    // Imported text is in the search index, which the triggers had to pick up.
    const { results } = await fetch(`${BASE}/api/search?q=happiness`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(results.length).toBeGreaterThan(0);
  }, 120_000);

  it('imports attachments and links them from the body', async () => {
    const cookie = await signUp();
    const client = liveClient(cookie);

    const progress = await importEnex(fileHandle('Appliance Manuals.enex'), client);

    expect(progress.created).toBe(93);
    expect(progress.failed).toBe(0);
    expect(progress.filesUploaded).toBeGreaterThan(0);

    const { items } = await fetch(`${BASE}/api/notes?limit=100`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    }).then((r) => r.json());

    // Find a note whose body references an attachment and fetch the blob it points at.
    let checked = 0;
    for (const item of items) {
      const note = await fetch(`${BASE}/api/notes/${item.id}`, {
        headers: { Cookie: cookie, Origin: ORIGIN },
      }).then((r) => r.json());

      const match = /\]\(files\/([^)]+)\)/.exec(note.body);
      if (!match) continue;

      const res = await fetch(
        `${BASE}/api/notes/${item.id}/files/${encodeURIComponent(match[1]!)}`,
        { headers: { Cookie: cookie, Origin: ORIGIN } },
      );
      expect(res.status).toBe(200);
      expect(Number(res.headers.get('content-length') ?? 0)).toBeGreaterThan(0);
      checked += 1;
      if (checked >= 3) break;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);

  it('is idempotent when re-run', async () => {
    const cookie = await signUp();
    const client = liveClient(cookie);

    const first = await importEnex(fileHandle('Quotes.enex'), client);
    const second = await importEnex(fileHandle('Quotes.enex'), client);

    expect(first.created).toBe(16);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(16);

    const { items } = await fetch(`${BASE}/api/notes?limit=100`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(items).toHaveLength(16);
  }, 180_000);
});
