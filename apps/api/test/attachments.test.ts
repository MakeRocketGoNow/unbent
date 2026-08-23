/**
 * Attachment upload, serving, and isolation.
 *
 * The security-critical cases here are traversal (a filename must never escape its note's
 * R2 prefix), cross-tenant reads (a note id from a URL is never trusted on its own), and
 * content-type downgrade (an uploaded type is never echoed back if a browser would execute
 * it).
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

  /**
   * A file's declared type is attacker-controlled — a request header on upload, or an ENEX
   * `<mime>` field on import. Echoing it back means a file uploaded as `text/html` becomes
   * a same-origin document: its scripts can read the app's DOM and call the API with the
   * user's session. These assert the response, not the stored metadata.
   */
  describe('content-type downgrade', () => {
    // Its own note: these upload several files, and a shared note would break the
    // exact-listing assertion elsewhere in this file.
    let note: { id: string };

    beforeAll(async () => {
      note = await createNote(alice, 'Content-type probes');
    }, 30_000);

    it('never serves an uploaded HTML file as HTML', async () => {
      const html = '<html><body><script>alert(1)</script></body></html>';
      const put = await upload(alice, note.id, 'evil.html', html, 'text/html');
      expect(put.status).toBe(201);

      const get = await fetch(`${BASE}/api/notes/${note.id}/files/evil.html`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      });

      expect(get.headers.get('content-type')).toBe('application/octet-stream');
      expect(get.headers.get('content-disposition')).toContain('attachment');
      // The bytes are still returned intact — this is about how they are labelled.
      expect(await get.text()).toBe(html);
    });

    it('is not fooled by a charset parameter', async () => {
      await upload(alice, note.id, 'charset.html', '<b>hi</b>', 'text/html; charset=utf-8');

      const get = await fetch(`${BASE}/api/notes/${note.id}/files/charset.html`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      });
      expect(get.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('is not fooled by casing', async () => {
      await upload(alice, note.id, 'upper.html', '<b>hi</b>', 'TEXT/HTML');

      const get = await fetch(`${BASE}/api/notes/${note.id}/files/upper.html`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      });
      expect(get.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('downgrades SVG, which browsers script despite it being an image', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      await upload(alice, note.id, 'evil.svg', svg, 'image/svg+xml');

      const get = await fetch(`${BASE}/api/notes/${note.id}/files/evil.svg`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      });
      expect(get.headers.get('content-type')).toBe('application/octet-stream');
      expect(get.headers.get('content-disposition')).toContain('attachment');
    });

    it('still serves a PDF inline, so preview keeps working', async () => {
      // %PDF header; the corpus is overwhelmingly PDFs and they must not regress.
      await upload(alice, note.id, 'doc.pdf', '%PDF-1.4 fake', 'application/pdf');

      const get = await fetch(`${BASE}/api/notes/${note.id}/files/doc.pdf`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      });
      expect(get.headers.get('content-type')).toBe('application/pdf');
      expect(get.headers.get('content-disposition')).toContain('inline');
    });

    it('sends a sandboxing CSP on every attachment response', async () => {
      // A PDF: the safe path, to prove the CSP is not only sent on downgraded responses.
      const get = await fetch(`${BASE}/api/notes/${note.id}/files/doc.pdf`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      });
      // Independent of the allowlist: denies an origin and script even if a type slips in.
      expect(get.headers.get('content-security-policy')).toContain('sandbox');
    });
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

/**
 * Destructive maintenance. These delete real data, so the confirmation gate and the
 * cross-tenant scoping matter more here than anywhere else in the API.
 */
describe('purge', () => {
  async function purge(actor: Actor, query: string): Promise<Response> {
    return fetch(`${BASE}/api/admin/purge-notes${query}`, {
      method: 'POST',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
  }

  it('refuses without the confirmation token', async () => {
    const actor = await signUp(`purge-guard-${Date.now()}@example.test`, 'purge-pass-1234', 'P');
    const note = await createNote(actor, 'Survives');

    expect((await purge(actor, '?scope=all')).status).toBe(400);
    expect((await purge(actor, '?scope=all&confirm=yes')).status).toBe(400);

    // Still there: a rejected purge must not have deleted anything.
    const res = await fetch(`${BASE}/api/notes/${note.id}`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
  });

  it('empties the trash without touching live notes', async () => {
    const actor = await signUp(`purge-trash-${Date.now()}@example.test`, 'purge-pass-1234', 'P');
    const keep = await createNote(actor, 'Keep');
    const drop = await createNote(actor, 'Drop');
    await upload(actor, drop.id, 'doomed.txt', 'bye');

    await fetch(`${BASE}/api/notes/${drop.id}`, {
      method: 'DELETE',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });

    const body = await (await purge(actor, '?scope=trashed&confirm=DELETE')).json();
    expect(body.notesDeleted).toBe(1);
    expect(body.filesDeleted).toBe(1);

    expect(
      (await fetch(`${BASE}/api/notes/${keep.id}`, {
        headers: { Cookie: actor.cookie, Origin: ORIGIN },
      })).status,
    ).toBe(200);
  });

  it('wipes every note and its attachments with scope=all', async () => {
    const actor = await signUp(`purge-all-${Date.now()}@example.test`, 'purge-pass-1234', 'P');
    const a = await createNote(actor, 'One');
    await createNote(actor, 'Two');
    await upload(actor, a.id, 'file.txt', 'data');

    const body = await (await purge(actor, '?scope=all&confirm=DELETE')).json();
    expect(body.notesDeleted).toBe(2);
    expect(body.filesDeleted).toBe(1);

    const { items } = await fetch(`${BASE}/api/notes?limit=100`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(items).toEqual([]);

    // The blob is gone from R2 too, not merely unreferenced.
    const gc = await fetch(`${BASE}/api/admin/gc-blobs`, {
      method: 'POST',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(gc.stored).toBe(0);
  });

  it('drops tags that no longer have notes', async () => {
    const actor = await signUp(`purge-tags-${Date.now()}@example.test`, 'purge-pass-1234', 'P');
    await fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify({ title: 'Tagged', body: 'x', tags: ['gone-after-purge'] }),
    });

    await purge(actor, '?scope=all&confirm=DELETE');

    const { tags } = await fetch(`${BASE}/api/tags`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(tags).toEqual([]);
  });

  it('never reaches another user notes', async () => {
    const victim = await signUp(`purge-victim-${Date.now()}@example.test`, 'purge-pass-1234', 'V');
    const victimNote = await createNote(victim, 'Not yours');
    await upload(victim, victimNote.id, 'safe.txt', 'safe');

    const attacker = await signUp(`purge-attacker-${Date.now()}@example.test`, 'purge-pass-1234', 'A');
    const body = await (await purge(attacker, '?scope=all&confirm=DELETE')).json();
    expect(body.notesDeleted).toBe(0);

    expect(
      (await fetch(`${BASE}/api/notes/${victimNote.id}`, {
        headers: { Cookie: victim.cookie, Origin: ORIGIN },
      })).status,
    ).toBe(200);
    expect(
      (await fetch(`${BASE}/api/notes/${victimNote.id}/files/safe.txt`, {
        headers: { Cookie: victim.cookie, Origin: ORIGIN },
      })).status,
    ).toBe(200);
  });

  it('requires a session', async () => {
    const res = await fetch(`${BASE}/api/admin/purge-notes?scope=all&confirm=DELETE`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });
});
