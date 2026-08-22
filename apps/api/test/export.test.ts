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
  body: { title?: string; body?: string; tags?: string[] },
): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Downloads the export and unpacks it into a path -> text map. */
async function fetchExport(actor: Actor): Promise<Map<string, string>> {
  const res = await fetch(`${BASE}/api/export`, {
    headers: { Cookie: actor.cookie, Origin: ORIGIN },
  });
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  expect(res.headers.get('content-type')).toBe('application/zip');

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

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`exp-alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`exp-bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
}, 30_000);

describe('export', () => {
  it('produces one note.md per note, in its own directory', async () => {
    await createNote(alice, { title: 'First note', body: 'one', tags: ['a'] });
    await createNote(alice, { title: 'Second note', body: 'two' });

    const files = [...(await fetchExport(alice)).keys()];
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('/note.md'))).toBe(true);
    expect(files.some((f) => f.startsWith('first-note-'))).toBe(true);
    expect(files.some((f) => f.startsWith('second-note-'))).toBe(true);
  });

  /** The property the whole design rests on: exported markdown parses back to the note. */
  it('round-trips content, tags, and timestamps through frontmatter', async () => {
    const created = await createNote(bob, {
      title: 'Q3: budget & "planning"',
      body: '# Heading\n\nBody with **markdown**.\n\n---\n\nAfter a rule.\n',
      tags: ['work', 'two words'],
    });

    const entry = [...(await fetchExport(bob)).entries()][0];
    expect(entry).toBeDefined();

    const note = parse(entry![1]);
    expect(note.id).toBe(created.id);
    expect(note.title).toBe('Q3: budget & "planning"');
    expect(note.tags.sort()).toEqual(['two words', 'work']);
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
    expect(name).toMatch(/^[a-z0-9-]+\/note\.md$/);
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

  it('includes attachments alongside note.md', async () => {
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
    expect(names[1]).toMatch(/^with-files-[0-9a-f]{8}\/note\.md$/);

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
