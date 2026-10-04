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
/**
 * The export's notebook of scanned PDFs, by file name. Configurable because the notebook
 * this was measured against is a real one, and its name does not belong in the repo.
 */
const PDF_FILE = process.env['ENEX_PDF_FILE'] ?? 'Scans.enex';
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
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  await emptyAccount(cookie);
  return cookie;
}

/**
 * Purges the welcome note every account is created with (apps/api/src/lib/welcome-note.ts),
 * so the account holds exactly what the import put there — which is what the counts and the
 * "every note is in Quotes" check below are about. The API suites do the same through
 * apps/api/test/empty-account.ts; this package does not reach into that one.
 */
async function emptyAccount(cookie: string): Promise<void> {
  const headers = { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN };
  const { items } = (await fetch(`${BASE}/api/notes`, { headers }).then((r) => r.json())) as {
    items: Array<{ id: string }>;
  };
  const ids = items.map((n) => n.id);
  if (ids.length === 0) return;
  for (const step of ['trash', 'purge']) {
    const res = await fetch(`${BASE}/api/notes/${step}`, { method: 'POST', headers, body: JSON.stringify({ ids }) });
    if (!res.ok) throw new Error(`${step} while emptying the account failed: ${res.status}`);
  }
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
    listFiles: async (noteId) => {
      const res = await fetch(`${BASE}/api/notes/${noteId}/files`, {
        headers: { Cookie: cookie, Origin: ORIGIN },
      });
      if (!res.ok) throw new Error(`listFiles ${res.status}`);
      const { files } = (await res.json()) as { files: Array<{ filename: string }> };
      return files.map((f) => f.filename);
    },
    saveFileText: async (noteId, filename, text) => {
      const res = await fetch(
        `${BASE}/api/notes/${noteId}/files/${encodeURIComponent(filename)}/text`,
        {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );
      if (!res.ok) throw new Error(`saveFileText ${res.status}: ${await res.text()}`);
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

    // The notebook name is stored on every note.
    expect(items.every((n: { notebook: string }) => n.notebook === 'Quotes')).toBe(true);

    // Imported text is in the search index, which the triggers had to pick up.
    const { results } = await fetch(`${BASE}/api/search?q=happiness`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(results.length).toBeGreaterThan(0);
  }, 120_000);

  it('imports attachments and links them from the body', async () => {
    const cookie = await signUp();
    const client = liveClient(cookie);

    const progress = await importEnex(fileHandle(PDF_FILE), client);

    expect(progress.created).toBeGreaterThan(0);
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

  /**
   * The reason this feature exists: most notes in the real corpus are a scan with an empty
   * body, so searching note text alone would never find them.
   */
  it('makes text inside scanned PDFs searchable', async () => {
    const cookie = await signUp();
    const client = liveClient(cookie);

    const progress = await importEnex(fileHandle(PDF_FILE), client, {
      extractText: true,
    });

    expect(progress.filesIndexed).toBeGreaterThan(0);

    // A word that appears only inside a scanned PDF, never in any note body.
    const { results } = await fetch(`${BASE}/api/search?q=pharmacy`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    }).then((r) => r.json());

    expect(results.length).toBeGreaterThan(0);
    // The hit names the file it matched, so the result is explicable.
    expect(results.some((r: { matchedFile?: string }) => r.matchedFile)).toBe(true);
  }, 600_000);

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
