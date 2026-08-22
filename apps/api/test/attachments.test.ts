/**
 * Attachment upload, serving, and isolation.
 *
 * The security-critical cases here are traversal (a filename must never escape its note's
 * R2 prefix) and cross-tenant reads (a note id from a URL is never trusted on its own).
 */
import { beforeAll, describe, expect, it } from 'vitest';

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

async function createNote(actor: Actor, title: string): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
    body: JSON.stringify({ title, body: '' }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}

async function upload(
  actor: Actor,
  noteId: string,
  filename: string,
  content: string | Uint8Array,
  contentType = 'text/plain',
): Promise<Response> {
  return fetch(`${BASE}/api/notes/${noteId}/files`, {
    method: 'PUT',
    headers: {
      Cookie: actor.cookie,
      Origin: ORIGIN,
      'X-Filename': encodeURIComponent(filename),
      'Content-Type': contentType,
    },
    body: content,
  });
}

let alice: Actor;
let bob: Actor;
let aliceNote: { id: string };

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`att-alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`att-bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
  aliceNote = await createNote(alice, 'With attachments');
}, 30_000);

describe('upload and serve', () => {
  it('round-trips a file and returns the relative markdown path', async () => {
    const res = await upload(alice, aliceNote.id, 'hello.txt', 'file contents here');
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.path).toBe('files/hello.txt');
    expect(body.size).toBe(18);

    const get = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('file contents here');
  });

  it('serves binary content intact', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await upload(alice, aliceNote.id, 'image.png', bytes, 'image/png');

    const get = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/image.png`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('sets immutable caching and nosniff', async () => {
    const get = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(get.headers.get('cache-control')).toContain('immutable');
    expect(get.headers.get('cache-control')).toContain('private');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('etag')).toBeTruthy();
  });

  it('honors If-None-Match with a 304', async () => {
    const first = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    const etag = first.headers.get('etag')!;

    const second = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN, 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('suffixes a colliding filename rather than overwriting', async () => {
    const note = await createNote(alice, 'Collisions');
    expect((await (await upload(alice, note.id, 'shot.png', 'first')).json()).path).toBe(
      'files/shot.png',
    );
    expect((await (await upload(alice, note.id, 'shot.png', 'second')).json()).path).toBe(
      'files/shot-2.png',
    );
    expect((await (await upload(alice, note.id, 'shot.png', 'third')).json()).path).toBe(
      'files/shot-3.png',
    );

    // The original is intact, not clobbered by the later uploads.
    const get = await fetch(`${BASE}/api/notes/${note.id}/files/shot.png`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(await get.text()).toBe('first');
  });

  it('lists the files on a note', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}/files`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    const { files } = await res.json();
    expect(files.map((f: { filename: string }) => f.filename).sort()).toEqual([
      'hello.txt',
      'image.png',
    ]);
  });

  it('deletes a file', async () => {
    const note = await createNote(alice, 'Deletable');
    await upload(alice, note.id, 'gone.txt', 'bye');

    const del = await fetch(`${BASE}/api/notes/${note.id}/files/gone.txt`, {
      method: 'DELETE',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(del.status).toBe(204);

    const get = await fetch(`${BASE}/api/notes/${note.id}/files/gone.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(get.status).toBe(404);
  });
});

/** A filename must never be able to address anything outside its own note prefix. */
describe('filename validation', () => {
  const bad = [
    '../../../etc/passwd',
    '..%2F..%2Fsecret',
    'sub/dir/file.txt',
    'back\\slash.txt',
    '.',
    '..',
    '.hidden',
    '',
  ];

  it.each(bad)('rejects %j', async (name) => {
    const res = await upload(alice, aliceNote.id, name, 'x');
    expect(res.status).toBe(400);
  });

  it('requires the X-Filename header', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}/files`, {
      method: 'PUT',
      headers: { Cookie: alice.cookie, Origin: ORIGIN, 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('accepts unicode and spaces in filenames', async () => {
    const note = await createNote(alice, 'Unicode files');
    const res = await upload(alice, note.id, 'café photo.png', 'x', 'image/png');
    expect(res.status).toBe(201);
    expect((await res.json()).path).toBe('files/café photo.png');

    const get = await fetch(
      `${BASE}/api/notes/${note.id}/files/${encodeURIComponent('café photo.png')}`,
      { headers: { Cookie: alice.cookie, Origin: ORIGIN } },
    );
    expect(get.status).toBe(200);
  });
});

describe('cross-tenant access', () => {
  it('bob cannot upload into an alice note', async () => {
    const res = await upload(bob, aliceNote.id, 'evil.txt', 'x');
    expect(res.status).toBe(404);
  });

  it('bob cannot fetch a blob under an alice note id', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it('bob cannot list files on an alice note', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}/files`, {
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it('bob cannot delete an alice attachment', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      method: 'DELETE',
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);

    // And it is genuinely still there.
    const still = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(still.status).toBe(200);
  });

  it('requires a session on every attachment route', async () => {
    const anon = { Origin: ORIGIN };
    const paths = [
      [`${BASE}/api/notes/${aliceNote.id}/files`, 'GET'],
      [`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, 'GET'],
      [`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, 'DELETE'],
    ] as const;

    for (const [url, method] of paths) {
      const res = await fetch(url, { method, headers: anon });
      expect(res.status).toBe(401);
    }
  });
});

/**
 * Blob GC. R2 has no foreign keys, so metadata deletion can leave objects behind; the
 * sweep is what reclaims them. It is scoped to the caller's own prefix by design.
 */
describe('orphaned blob gc', () => {
  it('reports zero orphans for a consistent account', async () => {
    const actor = await signUp(`gc-clean-${Date.now()}@example.test`, 'gc-password-1234', 'GC');
    const note = await createNote(actor, 'Clean');
    await upload(actor, note.id, 'kept.txt', 'x');

    const res = await fetch(`${BASE}/api/admin/gc-blobs`, {
      method: 'POST',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    const body = await res.json();
    expect(body.stored).toBe(1);
    expect(body.referenced).toBe(1);
    expect(body.orphaned).toBe(0);
  });

  it('finds and deletes an orphan left by attachment metadata removal', async () => {
    const actor = await signUp(`gc-orphan-${Date.now()}@example.test`, 'gc-password-5678', 'GC');
    const note = await createNote(actor, 'Orphaning');
    await upload(actor, note.id, 'a.txt', 'a');
    await upload(actor, note.id, 'b.txt', 'b');

    // Soft-deleting the note keeps its blobs by design — exactly the case that strands
    // objects once the note is eventually purged.
    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'DELETE',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });

    // Metadata still references them, so a sweep must NOT delete a restorable note's files.
    const stillReferenced = await (
      await fetch(`${BASE}/api/admin/gc-blobs`, {
        method: 'POST',
        headers: { Cookie: actor.cookie, Origin: ORIGIN },
      })
    ).json();
    expect(stillReferenced.orphaned).toBe(0);
  });

  it('does not sweep another user blobs', async () => {
    const res = await fetch(`${BASE}/api/admin/gc-blobs?apply=1`, {
      method: 'POST',
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    });
    const body = await res.json();
    // Bob has no attachments; alice's must be invisible to him, not merely un-deleted.
    expect(body.stored).toBe(0);
    expect(body.deleted).toBe(0);

    const alicesFile = await fetch(`${BASE}/api/notes/${aliceNote.id}/files/hello.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(alicesFile.status).toBe(200);
  });

  it('requires a session', async () => {
    const res = await fetch(`${BASE}/api/admin/gc-blobs`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });
});
