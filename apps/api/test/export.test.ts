/**
 * Export round-trip: the disaster-recovery guarantee.
 *
 * `wrangler d1 export` is broken on FTS5 databases, so the zip the browser builds is the
 * only backup. The browser builds it from pages of `GET /api/export/notes` (see the web
 * app's `export-archive.ts`, whose own tests cover the archive's layout), so what is
 * asserted here is the half the server owns: that a page carries everything a note needs
 * to come back — and only this user's notes, only the ones the filter names.
 */
import { BlobReader, ZipReader } from '@zip.js/zip.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyAccount } from './empty-account.js';
import { noteDirName, noteMarkdown, parse, textSidecarPath, type Note } from '@unbent/shared';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

interface Actor {
  cookie: string;
  userId: string;
}

async function signUp(email: string, password: string, name: string): Promise<Actor> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const body = (await res.json()) as { user: { id: string } };
  // Without its welcome note: this suite counts from an empty account. See empty-account.ts.
  await emptyAccount(BASE, ORIGIN, cookie);
  return { cookie, userId: body.user.id };
}

async function createNote(
  actor: Actor,
  body: { title?: string; body?: string; tags?: string[]; notebook?: string | null },
): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Unpacks a zip response body into a path -> text map. */
async function unzip(res: Response): Promise<Map<string, string>> {
  const reader = new ZipReader(new BlobReader(await res.blob()));
  const out = new Map<string, string>();
  for (const entry of await reader.getEntries()) {
    if (entry.directory || !entry.getData) continue;
    const chunks: string[] = [];
    await entry.getData(
      new WritableStream({
        write(chunk: Uint8Array) {
          chunks.push(new TextDecoder().decode(chunk, { stream: true }));
        },
      }),
    );
    out.set(entry.filename, chunks.join(''));
  }
  await reader.close();
  return out;
}

type ExportedNote = Note & {
  attachments?: Array<{ filename: string; contentType: string; text?: string; readBy?: 'vision' }>;
};
interface ExportPage {
  notes: ExportedNote[];
  cursor: string | null;
  total: number | null;
}

/** One page of the export, as the response itself, for assertions about status. */
function rawPage(
  actor: Actor,
  filter: Record<string, string | undefined> = {},
): Promise<Response> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
  const qs = params.toString();
  return fetch(`${BASE}/api/export/notes${qs ? `?${qs}` : ''}`, {
    headers: { Cookie: actor.cookie, Origin: ORIGIN },
  });
}

/** Every note the export names, walking the cursor the way the browser does. */
async function exportNotes(
  actor: Actor,
  filter: Record<string, string | undefined> = {},
): Promise<ExportedNote[]> {
  const notes: ExportedNote[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await rawPage(actor, { ...filter, cursor });
    if (!res.ok) throw new Error(`export page failed: ${res.status}`);
    const page = (await res.json()) as ExportPage;
    notes.push(...page.notes);
    if (!page.cursor) return notes;
    cursor = page.cursor;
  }
}

/**
 * The archive's markdown entries as the browser would write them: the shared names and
 * markdown applied to the pages. Keyed by path, so the assertions read as they did when
 * the server wrote the zip.
 */
async function fetchExport(
  actor: Actor,
  filter: Record<string, string | undefined> = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const note of await exportNotes(actor, filter)) {
    const dir = noteDirName(note.title, note.id);
    out.set(`${dir}/${dir}.md`, noteMarkdown(note));
    // The files' entries by name only; their bytes come through the note's file route.
    for (const file of note.attachments ?? []) {
      out.set(`${dir}/files/${file.filename}`, '');
      if (file.text) out.set(`${dir}/${textSidecarPath(file.filename, file.readBy)}`, file.text);
    }
  }
  return out;
}

/** Requests one note's download, following none of the branching itself. */
function fetchNote(actor: Actor, noteId: string): Promise<Response> {
  return fetch(`${BASE}/api/notes/${noteId}/export`, {
    headers: { Cookie: actor.cookie, Origin: ORIGIN },
  });
}

async function upload(
  actor: Actor,
  noteId: string,
  filename: string,
  content: string,
  contentType = 'text/plain',
  query = '',
): Promise<void> {
  const res = await fetch(`${BASE}/api/notes/${noteId}/files${query}`, {
    method: 'PUT',
    headers: {
      Cookie: actor.cookie,
      Origin: ORIGIN,
      'X-Filename': encodeURIComponent(filename),
      'Content-Type': contentType,
    },
    body: content,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
}

/**
 * A file with text already recorded, as the text route records it. Uploaded with
 * `text=supplied` so the Worker does not start reading it itself — a local instance may
 * hold a real vision key — and cannot land a read of its own over this one.
 */
async function uploadWithText(
  actor: Actor,
  noteId: string,
  file: { filename: string; contentType: string; text: string; readBy?: 'vision' },
): Promise<void> {
  await upload(actor, noteId, file.filename, 'BYTES', file.contentType, '?text=supplied');
  const res = await fetch(`${BASE}/api/notes/${noteId}/files/${encodeURIComponent(file.filename)}/text`, {
    method: 'PUT',
    headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: file.text, ...(file.readBy ? { readBy: file.readBy } : {}) }),
  });
  if (!res.ok) throw new Error(`text failed: ${res.status} ${await res.text()}`);
}

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`exp-alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`exp-bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
}, 30_000);

describe('export pages', () => {
  it('carries every note once, with what its directory needs', async () => {
    await createNote(alice, { title: 'First note', body: 'one', tags: ['a'] });
    await createNote(alice, { title: 'Second note', body: 'two' });

    const files = [...(await fetchExport(alice)).keys()];
    expect(files).toHaveLength(2);
    // Named for the note, not a fixed `note.md`: a Finder search for a title has to find
    // one file, not a thousand identical ones.
    expect(files.every((f) => /^([a-z0-9-]+)\/\1\.md$/.test(f))).toBe(true);
    expect(files.some((f) => f.startsWith('first-note-'))).toBe(true);
    expect(files.some((f) => f.startsWith('second-note-'))).toBe(true);
  });

  /** The property the whole design rests on: exported markdown parses back to the note. */
  it('round-trips content, tags, and timestamps through frontmatter', async () => {
    const created = await createNote(bob, {
      title: 'Q3: budget & "planning"',
      body: '# Heading\n\nBody with **markdown**.\n\n---\n\nAfter a rule.\n',
      tags: ['work', 'two words'],
      notebook: 'Work Notes',
    });

    const entry = [...(await fetchExport(bob)).entries()][0];
    expect(entry).toBeDefined();

    const note = parse(entry![1]);
    expect(note.id).toBe(created.id);
    expect(note.title).toBe('Q3: budget & "planning"');
    expect(note.tags.sort()).toEqual(['two words', 'work']);
    expect(note.notebook).toBe('Work Notes');
    expect(note.body).toBe('# Heading\n\nBody with **markdown**.\n\n---\n\nAfter a rule.\n');
    expect(note.created.getTime()).toBeGreaterThan(0);
    expect(note.updated.getTime()).toBeGreaterThanOrEqual(note.created.getTime());
  });

  /**
   * The browser walks the cursor, so a page has to hand back the next one and the last
   * has to say so; the total rides only on the first, for the progress count.
   */
  it('pages through the library with a cursor, counting once', async () => {
    const actor = await signUp(`exp-page-${Date.now()}@example.test`, 'page-password-12', 'P');
    await createNote(actor, { title: 'One', body: '1' });
    await createNote(actor, { title: 'Two', body: '2' });
    await createNote(actor, { title: 'Three', body: '3' });

    const first = (await (await rawPage(actor, { limit: '2' })).json()) as ExportPage;
    expect(first.notes).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.cursor).toBeTruthy();

    const second = (await (await rawPage(actor, { limit: '2', cursor: first.cursor! })).json()) as ExportPage;
    expect(second.notes).toHaveLength(1);
    expect(second.total).toBeNull();
    expect(second.cursor).toBeNull();

    const ids = [...first.notes, ...second.notes].map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('gives same-titled notes distinct directories', async () => {
    const actor = await signUp(`exp-dup-${Date.now()}@example.test`, 'dup-password-123', 'Dup');
    await createNote(actor, { title: 'Meeting notes', body: 'first' });
    await createNote(actor, { title: 'Meeting notes', body: 'second' });

    const files = await fetchExport(actor);
    // Two entries, not one overwriting the other.
    expect(files.size).toBe(2);
    expect([...files.values()].map((v) => parse(v).body).sort()).toEqual(['first', 'second']);
  });

  it('exports an empty account as an empty page', async () => {
    const actor = await signUp(`exp-empty-${Date.now()}@example.test`, 'empty-password-12', 'E');
    const page = (await (await rawPage(actor)).json()) as ExportPage;
    expect(page).toEqual({ notes: [], cursor: null, total: 0 });
  });

  it('excludes soft-deleted notes', async () => {
    const actor = await signUp(`exp-del-${Date.now()}@example.test`, 'del-password-1234', 'D');
    const keep = await createNote(actor, { title: 'Keep', body: 'keep' });
    const drop = await createNote(actor, { title: 'Drop', body: 'drop' });

    await fetch(`${BASE}/api/notes/${drop.id}`, {
      method: 'DELETE',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });

    const notes = await exportNotes(actor);
    expect(notes.map((n) => n.id)).toEqual([keep.id]);
  });

  /**
   * The names of a note's files ride with it, every stored file and not only the ones the
   * body still links; the browser fetches each through the note's file route. The
   * markdown link stays relative so the exported folder works without this app.
   */
  it('names every stored file beside the markdown', async () => {
    const actor = await signUp(`exp-att-${Date.now()}@example.test`, 'att-password-1234', 'A');
    const note = await createNote(actor, { title: 'With files', body: '![x](files/pic.png)' });
    await upload(actor, note.id, 'pic.png', 'PNGDATA', 'image/png');
    await upload(actor, note.id, 'unlinked.txt', 'kept');

    const [exported] = await exportNotes(actor);
    expect(exported!.attachments?.map((a) => a.filename).sort()).toEqual(['pic.png', 'unlinked.txt']);
    expect(exported!.body).toBe('![x](files/pic.png)');

    const res = await fetch(`${BASE}/api/notes/${note.id}/files/pic.png`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    expect(await res.text()).toBe('PNGDATA');
  });

  /**
   * And the text held for each, with who read it, so the archive can carry it in `text/`
   * or `described/` and a restore need not read every file again. A file with no text, or
   * an empty row, carries neither key.
   */
  it('carries the text held for each file, and who read it', async () => {
    const actor = await signUp(`exp-txt-${Date.now()}@example.test`, 'txt-password-1234', 'T');
    const note = await createNote(actor, { title: 'Paperwork', body: '' });
    await uploadWithText(actor, note.id, { filename: 'statement.pdf', contentType: 'application/pdf', text: 'Balance due 42.00' });
    await uploadWithText(actor, note.id, {
      filename: 'receipt.jpg',
      contentType: 'image/jpeg',
      text: 'Receipt from Acme',
      readBy: 'vision',
    });
    await upload(actor, note.id, 'notes.txt', 'plain', 'text/plain', '?text=supplied');

    const [exported] = await exportNotes(actor);
    expect(exported!.attachments?.sort((a, b) => a.filename.localeCompare(b.filename))).toEqual([
      { filename: 'notes.txt', contentType: 'text/plain' },
      { filename: 'receipt.jpg', contentType: 'image/jpeg', text: 'Receipt from Acme', readBy: 'vision' },
      { filename: 'statement.pdf', contentType: 'application/pdf', text: 'Balance due 42.00' },
    ]);

    // A single note's zip carries the same sidecars at its root.
    const zipped = await unzip(await fetchNote(actor, note.id));
    expect([...zipped.keys()].sort()).toEqual([
      'described/receipt.jpg.txt',
      'files/notes.txt',
      'files/receipt.jpg',
      'files/statement.pdf',
      `${noteDirName('Paperwork', note.id)}.md`,
      'text/statement.pdf.txt',
    ]);
    expect(zipped.get('text/statement.pdf.txt')).toBe('Balance due 42.00');
    expect(zipped.get('described/receipt.jpg.txt')).toBe('Receipt from Acme');
  });

  it('refuses a reader other than the vision model', async () => {
    const actor = await signUp(`exp-rdr-${Date.now()}@example.test`, 'rdr-password-1234', 'R');
    const note = await createNote(actor, { title: 'Reader', body: '' });
    await upload(actor, note.id, 'a.pdf', 'x', 'application/pdf', '?text=supplied');
    const res = await fetch(`${BASE}/api/notes/${note.id}/files/a.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'words', readBy: 'ocr' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await fetch(`${BASE}/api/export/notes`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
  });

  /** Cross-tenant: an export must never contain another user's notes. */
  it('contains only the requesting user notes', async () => {
    const files = await fetchExport(alice);
    const bodies = [...files.values()].map((v) => parse(v).body);
    expect(bodies).not.toContain('Body with **markdown**.');
    expect(bodies.every((b) => b === 'one' || b === 'two')).toBe(true);
  });
});

/**
 * Filtered export.
 *
 * The archive is the note list the user was looking at, so these assert the same filters
 * mean the same thing here as they do in the list — an export that quietly included more
 * than the view showed would be worse than one that refused.
 */
describe('filtered export', () => {
  it('exports only the notes in a notebook', async () => {
    const actor = await signUp(`nbexport-${Date.now()}@example.test`, 'nbexport-pass-1', 'N');
    const notebook = `Exported ${Date.now()}`;
    await createNote(actor, { title: 'Inside one', body: 'a', notebook });
    await createNote(actor, { title: 'Inside two', body: 'b', notebook });
    await createNote(actor, { title: 'Outside', body: 'c' });

    const names = [...(await fetchExport(actor, { notebook })).keys()].join('\n');
    expect(names).toContain('inside-one');
    expect(names).toContain('inside-two');
    expect(names).not.toContain('outside');
  });

  it('exports only the notes carrying a tag', async () => {
    const actor = await signUp(`tagexport-${Date.now()}@example.test`, 'tagexport-pass', 'T');
    const tag = `exported${Date.now()}`;
    await createNote(actor, { title: 'Tagged note', body: 'a', tags: [tag] });
    await createNote(actor, { title: 'Plain note', body: 'b' });

    const names = [...(await fetchExport(actor, { tag })).keys()].join('\n');
    expect(names).toContain('tagged-note');
    expect(names).not.toContain('plain-note');
  });

  it('still exports everything when unfiltered', async () => {
    const actor = await signUp(`allexport-${Date.now()}@example.test`, 'allexport-pass', 'A');
    await createNote(actor, { title: 'First one', body: 'a', notebook: 'Somewhere' });
    await createNote(actor, { title: 'Second one', body: 'b' });

    const names = [...(await fetchExport(actor)).keys()].join('\n');
    expect(names).toContain('first-one');
    expect(names).toContain('second-one');
  });

  it('answers an empty page when the filter matches nothing', async () => {
    const actor = await signUp(`emptyexport-${Date.now()}@example.test`, 'empty-pass-12', 'E');
    await createNote(actor, { title: 'Unmatched', body: 'a' });

    // A filter that excludes everything is a real thing to ask for by accident; the
    // browser then writes an archive that opens and says so.
    const page = (await (await rawPage(actor, { notebook: `Nothing ${Date.now()}` })).json()) as ExportPage;
    expect(page.notes).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('reads the date range against the column the sort names', async () => {
    /**
     * The range filters whichever date the list was ordered by, so an export of "2021"
     * has to mean the same notes the user was looking at. A note created in 2021 and
     * edited in 2026 belongs to a `created` range and not to an `updated` one.
     */
    const actor = await signUp(`sortrange-${Date.now()}@example.test`, 'sortrange-pass', 'S');
    const created2021 = Date.parse('2021-06-01T12:00:00Z');
    await fetch(`${BASE}/api/import/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify({
        title: 'Filed in 2021 edited later',
        body: 'x',
        createdAt: created2021,
        updatedAt: Date.parse('2026-01-01T12:00:00Z'),
        contentHash: `sortrange${Date.now()}`.padEnd(64, '0').slice(0, 64),
      }),
    });

    const byCreated = [
      ...(await fetchExport(actor, { from: '2021-01-01', to: '2021-12-31', sort: 'created' })).keys(),
    ].join('\n');
    expect(byCreated).toContain('filed-in-2021-edited-later');

    // The same range under the updated sort means "updated in 2021", which this is not.
    const byUpdated = [
      ...(await fetchExport(actor, { from: '2021-01-01', to: '2021-12-31', sort: 'updated' })).keys(),
    ].join('\n');
    expect(byUpdated).not.toContain('filed-in-2021-edited-later');

    // The default sort is creation date, so a range with no sort names that column.
    const byDefault = [
      ...(await fetchExport(actor, { from: '2021-01-01', to: '2021-12-31' })).keys(),
    ].join('\n');
    expect(byDefault).toContain('filed-in-2021-edited-later');

    // A title sort has no date of its own; its rows show the updated date, so its range
    // means "updated in": this note is in 2026's slice and not in 2021's.
    const byTitle2026 = [
      ...(await fetchExport(actor, { from: '2026-01-01', to: '2026-12-31', sort: 'title' })).keys(),
    ].join('\n');
    expect(byTitle2026).toContain('filed-in-2021-edited-later');
    const byTitle2021 = [
      ...(await fetchExport(actor, { from: '2021-01-01', to: '2021-12-31', sort: 'title' })).keys(),
    ].join('\n');
    expect(byTitle2021).not.toContain('filed-in-2021-edited-later');
  });

  it('rejects a malformed date rather than exporting everything', async () => {
    const actor = await signUp(`badexport-${Date.now()}@example.test`, 'badexport-pass', 'B');
    await createNote(actor, { title: 'Present', body: 'a' });

    // Silently ignoring an unparseable bound would hand back a wider archive than asked
    // for, which is the one failure mode an export must not have.
    const res = await rawPage(actor, { from: 'whenever' });
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });

  it('never exports another user notes through a filter', async () => {
    const notebook = `Shared name ${Date.now()}`;
    await createNote(alice, { title: 'Alice private', body: 'a', notebook });
    await createNote(bob, { title: 'Bob private', body: 'b', notebook });

    const names = [...(await fetchExport(bob, { notebook })).keys()].join('\n');
    expect(names).toContain('bob-private');
    expect(names).not.toContain('alice-private');
  });
});

describe('single-note export', () => {
  it('serves a bare .md when the note has no attachments', async () => {
    const actor = await signUp(`one-md-${Date.now()}@example.test`, 'md-password-1234', 'M');
    const created = await createNote(actor, {
      title: 'Solo note',
      body: '# Alone\n\nNo files here.\n',
      tags: ['solo'],
    });

    const res = await fetchNote(actor, created.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/solo-note-[0-9a-f]{8}\.md/);

    // Same frontmatter contract as the library export: it parses back to the note.
    const note = parse(await res.text());
    expect(note.id).toBe(created.id);
    expect(note.title).toBe('Solo note');
    expect(note.tags).toEqual(['solo']);
    expect(note.body).toBe('# Alone\n\nNo files here.\n');
  });

  it('serves a zipped folder when the note has attachments', async () => {
    const actor = await signUp(`one-zip-${Date.now()}@example.test`, 'zip-password-123', 'Z');
    const created = await createNote(actor, {
      title: 'With files',
      body: 'See ![pic](files/pic.png)',
    });
    await upload(actor, created.id, 'pic.png', 'PNGDATA', 'image/png');

    const res = await fetchNote(actor, created.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/with-files-[0-9a-f]{8}\.zip/);

    const files = await unzip(res);
    const names = [...files.keys()].sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('files/pic.png');
    expect(names[1]).toMatch(/^with-files-[0-9a-f]{8}\.md$/);
    expect(files.get(names[0]!)).toBe('PNGDATA');

    // The link stays relative, which is what makes it resolve against the unpacked
    // `files/` directory rather than pointing back at this app.
    expect(parse(files.get(names[1]!)!).body).toBe('See ![pic](files/pic.png)');
  });

  /**
   * Archive Utility is the extractor a download actually meets.
   *
   * Entries are streamed, so their length is unknown when the local header is written, and
   * zip.js answers that by reserving Zip64 space — `0xffffffff` size placeholders and
   * extract version 45 — even for a one-kilobyte note. Command-line unzip reads it; macOS
   * Archive Utility refuses the whole archive with "Error 79 - Inappropriate file type or
   * format", so a double-click in Finder produced nothing at all.
   *
   * The bytes are asserted rather than the round-trip because `unzip()` above uses zip.js
   * to read, which accepts its own Zip64 output happily — the regression is invisible to
   * every other test in this file.
   */
  it('writes headers a plain zip reader accepts, without Zip64', async () => {
    const actor = await signUp(`one-z64-${Date.now()}@example.test`, 'zip64-password-1', 'Z');
    const created = await createNote(actor, { title: 'Header check', body: '![p](files/p.png)' });
    await upload(actor, created.id, 'p.png', 'PNGDATA', 'image/png');

    const bytes = new Uint8Array(await (await fetchNote(actor, created.id)).arrayBuffer());
    const view = new DataView(bytes.buffer);

    // Local file header: "PK\x03\x04", then the version needed to extract.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    // 20 is "2.0 — deflate"; 45 is "4.5 — Zip64", which is what Archive Utility rejects.
    expect(view.getUint16(4, true)).toBeLessThanOrEqual(20);

    // No Zip64 end-of-central-directory locator ("PK\x06\x07") before the EOCD record.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    expect(eocd).toBeGreaterThanOrEqual(0);
    const locator =
      eocd >= 20 &&
      bytes[eocd - 20] === 0x50 &&
      bytes[eocd - 19] === 0x4b &&
      bytes[eocd - 18] === 0x06 &&
      bytes[eocd - 17] === 0x07;
    expect(locator).toBe(false);
  });

  /**
   * The reason both paths share one writer: the markdown must sit one level above its own
   * `files/` in both, or the relative links break. The single-note zip differs only by the
   * note directory the library export needs to keep notes apart.
   */
  it('matches the library layout once the note directory is stripped', async () => {
    const actor = await signUp(`one-same-${Date.now()}@example.test`, 'same-password-12', 'S');
    const created = await createNote(actor, { title: 'Same shape', body: '[a](files/a.txt)' });
    await upload(actor, created.id, 'a.txt', 'AAA');

    const single = [...(await unzip(await fetchNote(actor, created.id))).keys()].sort();
    const library = [...(await fetchExport(actor)).keys()]
      .map((n) => n.replace(/^[^/]+\//, ''))
      .sort();
    expect(single).toEqual(library);
  });

  /** No directory wrapping a zip that is already named for the note. */
  it('writes at the archive root rather than nesting a note directory', async () => {
    const actor = await signUp(`one-flat-${Date.now()}@example.test`, 'flat-password-12', 'F');
    const created = await createNote(actor, { title: 'Flat note', body: '![p](files/p.png)' });
    await upload(actor, created.id, 'p.png', 'PNG', 'image/png');

    const names = [...(await unzip(await fetchNote(actor, created.id))).keys()];
    expect(names.some((n) => /^flat-note-[0-9a-f]{8}\.md$/.test(n))).toBe(true);
    // Nothing sits inside a directory named for the note.
    expect(names.every((n) => !/^flat-note-[0-9a-f]{8}\//.test(n))).toBe(true);
  });

  it('includes files whose link was removed from the body', async () => {
    const actor = await signUp(`one-unl-${Date.now()}@example.test`, 'unl-password-123', 'U');
    // Body never references the upload — the leftover an Attachments panel calls
    // "not linked". It is still part of the note, so the download must carry it.
    const created = await createNote(actor, { title: 'Orphan file', body: 'no links' });
    await upload(actor, created.id, 'stray.txt', 'STRAY');

    const files = await unzip(await fetchNote(actor, created.id));
    expect([...files.keys()]).toContain('files/stray.txt');
    expect(files.get('files/stray.txt')).toBe('STRAY');
  });

  it('404s a trashed note, matching the library export', async () => {
    const actor = await signUp(`one-del-${Date.now()}@example.test`, 'del-password-1234', 'D');
    const created = await createNote(actor, { title: 'Doomed', body: 'x' });
    await fetch(`${BASE}/api/notes/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });

    expect((await fetchNote(actor, created.id)).status).toBe(404);
  });

  it('requires a session', async () => {
    const created = await createNote(alice, { title: 'Private', body: 'x' });
    const res = await fetch(`${BASE}/api/notes/${created.id}/export`, {
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  /** Cross-tenant: a note id alone must not be enough to read someone else's note. */
  it('404s another user note rather than serving it', async () => {
    const created = await createNote(alice, { title: 'Alice only', body: 'secret' });
    expect((await fetchNote(bob, created.id)).status).toBe(404);
  });
});

describe('custom fields in the export', () => {
  /**
   * Values ride out as top-level frontmatter keys named by their field, typed as YAML
   * scalars, and parse back as the same values — the same identity property the note's
   * own metadata is held to, extended to what a person has defined.
   */
  it('writes every value as a frontmatter key that parses back typed', async () => {
    const actor = await signUp(`exp-fld-${Date.now()}@example.test`, 'fld-password-1234', 'F');
    const headers = { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN };
    const nb = await fetch(`${BASE}/api/notebooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Receipts' }),
    }).then((r) => r.json());
    const field = (name: string, type: string) =>
      fetch(`${BASE}/api/notebooks/${nb.id}/fields`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, type }),
      }).then((r) => r.json() as Promise<{ id: string }>);
    const merchant = await field('Merchant', 'text');
    const amount = await field('Amount', 'number');
    const paid = await field('Paid', 'checkbox');
    const on = await field('Paid on', 'date');
    const platforms = await fetch(`${BASE}/api/notebooks/${nb.id}/fields`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Platforms', type: 'multiselect', options: ['PC', 'PS5', 'Switch'] }),
    }).then((r) => r.json() as Promise<{ id: string }>);

    const created = await fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Lunch',
        body: 'x',
        notebook: 'Receipts',
        fields: {
          [merchant.id]: 'Acme',
          [amount.id]: 12.5,
          [paid.id]: true,
          [on.id]: '2024-03-01',
          [platforms.id]: ['PS5', 'PC'],
        },
      }),
    }).then((r) => r.json());

    // A multi-select rides out as a YAML list, in the option list's order.
    const expected = { Merchant: 'Acme', Amount: 12.5, Paid: true, 'Paid on': '2024-03-01', Platforms: ['PC', 'PS5'] };
    const entry = [...(await fetchExport(actor)).values()][0]!;
    expect(parse(entry).fields).toEqual(expected);
    expect(parse(entry).notebook).toBe('Receipts');

    // The single-note download is the same text.
    expect(parse(await (await fetchNote(actor, created.id)).text()).fields).toEqual(expected);
  });
});
