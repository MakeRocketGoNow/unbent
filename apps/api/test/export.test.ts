/**
 * Export round-trip: the disaster-recovery guarantee.
 *
 * `wrangler d1 export` is broken on FTS5 databases, so this zip is the only backup. These
 * tests assert the archive is real and complete — that a user can actually leave.
 */
import { BlobReader, ZipReader } from '@zip.js/zip.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from '@unbent/shared';

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

/** Downloads the library export, optionally filtered, and unpacks it. */
async function fetchExport(
  actor: Actor,
  filter: { tag?: string; notebook?: string; from?: string; to?: string; sort?: string } = {},
): Promise<Map<string, string>> {
  const res = await rawExport(actor, filter);
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  expect(res.headers.get('content-type')).toBe('application/zip');
  return unzip(res);
}

/** The export response itself, for assertions about status and headers. */
function rawExport(
  actor: Actor,
  filter: Record<string, string | undefined> = {},
): Promise<Response> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
  const qs = params.toString();
  return fetch(`${BASE}/api/export${qs ? `?${qs}` : ''}`, {
    headers: { Cookie: actor.cookie, Origin: ORIGIN },
  });
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
): Promise<void> {
  const res = await fetch(`${BASE}/api/notes/${noteId}/files`, {
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

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`exp-alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`exp-bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
}, 30_000);

describe('export', () => {
  it('produces one markdown file per note, in its own directory', async () => {
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

  it('gives same-titled notes distinct directories', async () => {
    const actor = await signUp(`exp-dup-${Date.now()}@example.test`, 'dup-password-123', 'Dup');
    await createNote(actor, { title: 'Meeting notes', body: 'first' });
    await createNote(actor, { title: 'Meeting notes', body: 'second' });

    const files = await fetchExport(actor);
    // Two entries, not one overwriting the other.
    expect(files.size).toBe(2);
    expect(new Set([...files.keys()]).size).toBe(2);
    expect([...files.values()].map((v) => parse(v).body).sort()).toEqual(['first', 'second']);
  });

  it('slugifies unicode and punctuation into filesystem-safe names', async () => {
    const actor = await signUp(`exp-uni-${Date.now()}@example.test`, 'uni-password-1234', 'Uni');
    await createNote(actor, { title: 'Café ☕ / Notes: 2024!', body: 'x' });

    const name = [...(await fetchExport(actor)).keys()][0] ?? '';
    expect(name).toMatch(/^([a-z0-9-]+)\/\1\.md$/);
    expect(name).toContain('cafe');
  });

  it('exports an empty account without erroring', async () => {
    const actor = await signUp(`exp-empty-${Date.now()}@example.test`, 'empty-password-12', 'E');
    const files = await fetchExport(actor);
    expect(files.has('README.txt')).toBe(true);
  });

  it('excludes soft-deleted notes', async () => {
    const actor = await signUp(`exp-del-${Date.now()}@example.test`, 'del-password-1234', 'D');
    const keep = await createNote(actor, { title: 'Keep', body: 'keep' });
    const drop = await createNote(actor, { title: 'Drop', body: 'drop' });

    await fetch(`${BASE}/api/notes/${drop.id}`, {
      method: 'DELETE',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });

    const files = await fetchExport(actor);
    expect(files.size).toBe(1);
    expect(parse([...files.values()][0]!).id).toBe(keep.id);
  });

  it('includes attachments alongside the markdown', async () => {
    const actor = await signUp(`exp-att-${Date.now()}@example.test`, 'att-password-1234', 'A');
    const note = await createNote(actor, { title: 'With files', body: '![x](files/pic.png)' });

    await fetch(`${BASE}/api/notes/${note.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: actor.cookie,
        Origin: ORIGIN,
        'X-Filename': 'pic.png',
        'Content-Type': 'image/png',
      },
      body: 'PNGDATA',
    });

    const files = await fetchExport(actor);
    const names = [...files.keys()].sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^with-files-[0-9a-f]{8}\/files\/pic\.png$/);
    expect(names[1]).toMatch(/^(with-files-[0-9a-f]{8})\/\1\.md$/);

    // The attachment bytes survive, and the markdown link stays relative so the exported
    // folder works without this app.
    expect(files.get(names[0]!)).toBe('PNGDATA');
    expect(parse(files.get(names[1]!)!).body).toBe('![x](files/pic.png)');
  });

  it('requires a session', async () => {
    const res = await fetch(`${BASE}/api/export`, { headers: { Origin: ORIGIN } });
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
 * Single-note download.
 *
 * The shape is conditional — bare markdown with no attachments, a zip with them — so the
 * branch itself is the thing under test, along with the property that makes the zip worth
 * producing: the markdown sits one level above its own `files/`, so the relative `files/…`
 * links resolve once it is unpacked.
 *
 * Unlike the library export this writes at the archive root: the zip is already named for
 * the note, so a directory inside it would repeat that name for nothing.
 */
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

    const entries = await fetchExport(actor, { notebook });
    const names = [...entries.keys()].join('\n');

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

  it('names the file after the slice it contains', async () => {
    const actor = await signUp(`namedexport-${Date.now()}@example.test`, 'named-pass-12', 'F');
    const notebook = 'Appliance Manuals';
    await createNote(actor, { title: 'Only', body: 'a', notebook });

    const res = await rawExport(actor, { notebook, from: '2020-01-01' });
    const disposition = res.headers.get('content-disposition') ?? '';
    await res.body?.cancel();

    // Several slices land in one downloads folder; the name has to say which is which.
    expect(disposition).toContain('unbent-medical-history-2020-01-01-to-now');
  });

  it('keeps the original filename when unfiltered', async () => {
    const actor = await signUp(`plainname-${Date.now()}@example.test`, 'plainname-pass', 'P');
    await createNote(actor, { title: 'Anything', body: 'a' });

    const res = await rawExport(actor);
    expect(res.headers.get('content-disposition')).toContain('unbent-export-');
    await res.body?.cancel();
  });

  it('still exports everything when unfiltered', async () => {
    const actor = await signUp(`allexport-${Date.now()}@example.test`, 'allexport-pass', 'A');
    await createNote(actor, { title: 'First one', body: 'a', notebook: 'Somewhere' });
    await createNote(actor, { title: 'Second one', body: 'b' });

    const names = [...(await fetchExport(actor)).keys()].join('\n');
    expect(names).toContain('first-one');
    expect(names).toContain('second-one');
  });

  it('produces a valid empty archive when the filter matches nothing', async () => {
    const actor = await signUp(`emptyexport-${Date.now()}@example.test`, 'empty-pass-12', 'E');
    await createNote(actor, { title: 'Unmatched', body: 'a' });

    // A filter that excludes everything is a real thing to ask for by accident; it should
    // open and say so rather than produce a corrupt file.
    const entries = await fetchExport(actor, { notebook: `Nothing ${Date.now()}` });
    expect([...entries.keys()]).toEqual(['README.txt']);
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

    // The same range under the default sort means "updated in 2021", which this is not.
    const byUpdated = [
      ...(await fetchExport(actor, { from: '2021-01-01', to: '2021-12-31' })).keys(),
    ].join('\n');
    expect(byUpdated).not.toContain('filed-in-2021-edited-later');

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
    const res = await rawExport(actor, { from: 'whenever' });
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
