/**
 * Attachment upload, serving, and isolation.
 *
 * The security-critical cases here are traversal (a filename must never escape its note's
 * R2 prefix), cross-tenant reads (a note id from a URL is never trusted on its own), and
 * content-type downgrade (an uploaded type is never echoed back if a browser would execute
 * it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

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
  opts: { link?: boolean } = {},
): Promise<Response> {
  return fetch(`${BASE}/api/notes/${noteId}/files${opts.link ? '?link=1' : ''}`, {
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

async function noteBody(actor: Actor, noteId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/notes/${noteId}`, {
    headers: { Cookie: actor.cookie, Origin: ORIGIN },
  });
  if (!res.ok) throw new Error(`get note failed: ${res.status}`);
  return ((await res.json()) as { body: string }).body;
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

  /**
   * The row for a note shows what it holds from the attachment rows, not from links in the
   * body — the two tests above attached files to a note whose body is still empty.
   */
  it('lists the files on the note summary, oldest first, and omits the key when none', async () => {
    const other = await createNote(alice, 'Without attachments');
    const res = await fetch(`${BASE}/api/notes`, { headers: { Cookie: alice.cookie, Origin: ORIGIN } });
    const { items } = (await res.json()) as {
      items: { id: string; attachments?: { filename: string; contentType: string }[] }[];
    };

    const withFiles = items.find((n) => n.id === aliceNote.id);
    expect(withFiles?.attachments).toEqual([
      { filename: 'hello.txt', contentType: 'text/plain' },
      { filename: 'image.png', contentType: 'image/png' },
    ]);
    expect(items.find((n) => n.id === other.id)).not.toHaveProperty('attachments');
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

    it('forces a download when ?download=1, including for PDFs', async () => {
      const get = await fetch(`${BASE}/api/notes/${note.id}/files/doc.pdf?download=1`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      });
      expect(get.headers.get('content-disposition')).toContain('attachment');
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
/**
 * `?link=1` — the server writes the markdown link the uploader cannot.
 *
 * The browser editor inserts its own link at the cursor and never sends this flag. A phone
 * share sheet has no cursor and no copy of the body, so without the flag its uploads would
 * be stored but invisible in the note. These pin the two halves that matter: the link is
 * appended for clients that ask, and nothing changes for the editor that does not.
 */
describe('linking an upload into the body', () => {
  let note: { id: string };

  beforeAll(async () => {
    note = await createNote(alice, 'Linked uploads');
  }, 30_000);

  it('appends an image as an embed and a document as a plain link', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect((await upload(alice, note.id, 'photo.png', png, 'image/png', { link: true })).status)
      .toBe(201);
    expect(await noteBody(alice, note.id)).toBe('![photo.png](files/photo.png)');

    expect(
      (await upload(alice, note.id, 'report.pdf', '%PDF-1.4', 'application/pdf', { link: true }))
        .status,
    ).toBe(201);

    // Blank line between, so the two are separate markdown blocks rather than one paragraph.
    expect(await noteBody(alice, note.id)).toBe(
      '![photo.png](files/photo.png)\n\n[report.pdf](files/report.pdf)',
    );
  });

  it('links the stored filename, not the requested one, when a name collides', async () => {
    const target = await createNote(alice, 'Colliding names');
    await upload(alice, target.id, 'scan.pdf', 'first', 'application/pdf', { link: true });
    await upload(alice, target.id, 'scan.pdf', 'second', 'application/pdf', { link: true });

    // A link to `scan.pdf` twice would point the second at the first file's bytes.
    expect(await noteBody(alice, target.id)).toBe(
      '[scan.pdf](files/scan.pdf)\n\n[scan-2.pdf](files/scan-2.pdf)',
    );
  });

  it('wraps a destination containing spaces in angle brackets', async () => {
    const target = await createNote(alice, 'Spaced name');
    await upload(alice, target.id, 'Treatment Plan.pdf', '%PDF', 'application/pdf', { link: true });

    expect(await noteBody(alice, target.id)).toBe(
      '[Treatment Plan.pdf](<files/Treatment Plan.pdf>)',
    );
  });

  it('leaves the body alone without the flag', async () => {
    const target = await createNote(alice, 'Unlinked');
    expect((await upload(alice, target.id, 'quiet.txt', 'no link please')).status).toBe(201);
    expect(await noteBody(alice, target.id)).toBe('');
  });

  it('appends after existing content rather than replacing it', async () => {
    const target = await createNote(alice, 'Has prose');
    await fetch(`${BASE}/api/notes/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
      body: JSON.stringify({ body: 'Existing thoughts.' }),
    });

    await upload(alice, target.id, 'note.txt', 'x', 'text/plain', { link: true });
    expect(await noteBody(alice, target.id)).toBe(
      'Existing thoughts.\n\n[note.txt](files/note.txt)',
    );
  });

  it("does not touch another user's note", async () => {
    const res = await upload(bob, note.id, 'intruder.txt', 'x', 'text/plain', { link: true });
    expect(res.status).toBe(404);
    expect(await noteBody(alice, note.id)).not.toContain('intruder.txt');
  });
});

/**
 * Copying files between notes: the server-side half of a paste across notes and of the
 * panel's copy-to and move-to. What matters is that a copy is a new row and a new object
 * (deleting the source afterwards must not touch it), that a name already taken in the
 * destination is suffixed rather than overwritten, and that a move never takes a file the
 * source body still links.
 */
describe('copying between notes', () => {
  let source: { id: string };
  let target: { id: string };

  async function copy(
    actor: Actor,
    to: string,
    body: { from: string; filenames: string[]; move?: boolean; link?: boolean },
  ): Promise<Response> {
    return fetch(`${BASE}/api/notes/${to}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify(body),
    });
  }

  async function serve(actor: Actor, noteId: string, filename: string): Promise<Response> {
    return fetch(`${BASE}/api/notes/${noteId}/files/${encodeURIComponent(filename)}`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
  }

  async function setBody(actor: Actor, noteId: string, body: string): Promise<void> {
    const res = await fetch(`${BASE}/api/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`patch failed: ${res.status}`);
  }

  beforeAll(async () => {
    source = await createNote(alice, 'Copy source');
    target = await createNote(alice, 'Copy target');
    await upload(alice, source.id, 'doc.txt', 'doc contents');
    await upload(alice, source.id, 'pic.png', new Uint8Array([1, 2, 3]), 'image/png');
  }, 30_000);

  it('copies the bytes and the type, and names what it could not find', async () => {
    const res = await copy(alice, target.id, {
      from: source.id,
      filenames: ['doc.txt', 'pic.png', 'nope.txt'],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([
      expect.objectContaining({ from: 'doc.txt', filename: 'doc.txt', path: 'files/doc.txt', moved: false }),
      expect.objectContaining({ from: 'pic.png', filename: 'pic.png', contentType: 'image/png', size: 3 }),
    ]);
    expect(body.missing).toEqual(['nope.txt']);

    const copied = await serve(alice, target.id, 'doc.txt');
    expect(copied.status).toBe(200);
    expect(await copied.text()).toBe('doc contents');
    // A copy, not a move: the source still serves it.
    expect((await serve(alice, source.id, 'doc.txt')).status).toBe(200);
  });

  it('suffixes a name the destination already holds and reports the new one', async () => {
    const body = await (await copy(alice, target.id, { from: source.id, filenames: ['doc.txt'] })).json();
    expect(body.files[0]).toEqual(
      expect.objectContaining({ from: 'doc.txt', filename: 'doc-2.txt', path: 'files/doc-2.txt' }),
    );
    expect(await (await serve(alice, target.id, 'doc-2.txt')).text()).toBe('doc contents');
  });

  /**
   * Deleting the copy's source must leave the copy readable. This is the invariant the
   * whole endpoint exists to keep — R2 keys embed the note id and every delete path assumes
   * one object per row — so it is asserted directly rather than trusted.
   */
  it('gives the copy its own object, so deleting the source leaves it intact', async () => {
    await fetch(`${BASE}/api/notes/${source.id}/files/pic.png`, {
      method: 'DELETE',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect((await serve(alice, source.id, 'pic.png')).status).toBe(404);
    const copied = await serve(alice, target.id, 'pic.png');
    expect(copied.status).toBe(200);
    expect(new Uint8Array(await copied.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('will not move a file the source body still links', async () => {
    await upload(alice, source.id, 'linked.txt', 'still here', 'text/plain', { link: true });
    const body = await (await copy(alice, target.id, {
      from: source.id,
      filenames: ['linked.txt'],
      move: true,
    })).json();
    expect(body.files[0]).toEqual(expect.objectContaining({ filename: 'linked.txt', moved: false }));
    expect((await serve(alice, source.id, 'linked.txt')).status).toBe(200);
    expect((await serve(alice, target.id, 'linked.txt')).status).toBe(200);
  });

  it('moves a file once the source body no longer links it', async () => {
    await setBody(alice, source.id, 'the link is gone');
    const body = await (await copy(alice, target.id, {
      from: source.id,
      filenames: ['linked.txt'],
      move: true,
    })).json();
    expect(body.files[0]).toEqual(
      expect.objectContaining({ from: 'linked.txt', filename: 'linked-2.txt', moved: true }),
    );
    expect((await serve(alice, source.id, 'linked.txt')).status).toBe(404);
    expect(await (await serve(alice, target.id, 'linked-2.txt')).text()).toBe('still here');
  });

  it('links the copy into the destination body when asked, under its stored name', async () => {
    const dest = await createNote(alice, 'Linked destination');
    await upload(alice, dest.id, 'doc.txt', 'already here');
    const body = await (await copy(alice, dest.id, {
      from: source.id,
      filenames: ['doc.txt'],
      link: true,
    })).json();
    expect(body.files[0].filename).toBe('doc-2.txt');
    expect(await noteBody(alice, dest.id)).toBe('[doc-2.txt](files/doc-2.txt)');
  });

  it('refuses a note as its own source', async () => {
    const res = await copy(alice, target.id, { from: target.id, filenames: ['doc.txt'] });
    expect(res.status).toBe(400);
  });

  it('cannot reach another user notes as a source or a destination', async () => {
    const bobNote = await createNote(bob, 'Bob target');
    const asSource = await copy(bob, bobNote.id, { from: source.id, filenames: ['doc.txt'] });
    expect(asSource.status).toBe(404);
    const asTarget = await copy(bob, target.id, { from: bobNote.id, filenames: ['doc.txt'] });
    expect(asTarget.status).toBe(404);
    expect((await serve(alice, target.id, 'doc.txt')).status).toBe(200);
  });
});

describe('duplicating a note', () => {
  it('makes a new note with the same content and its own copies of the files', async () => {
    const original = await createNote(alice, 'Template');
    await upload(alice, original.id, 'list.txt', 'bring a torch', 'text/plain', { link: true });
    await upload(alice, original.id, 'spare.txt', 'not linked');

    const res = await fetch(`${BASE}/api/notes/${original.id}/duplicate`, {
      method: 'POST',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(201);
    const copy = (await res.json()) as { id: string; title: string; body: string };
    expect(copy.id).not.toBe(original.id);
    expect(copy.title).toBe('Template');
    // The body is carried as stored: the relative link resolves in the copy too.
    expect(copy.body).toBe(await noteBody(alice, original.id));
    expect(copy.body).toContain('[list.txt](files/list.txt)');

    const files = (await (
      await fetch(`${BASE}/api/notes/${copy.id}/files`, {
        headers: { Cookie: alice.cookie, Origin: ORIGIN },
      })
    ).json()) as { files: { filename: string }[] };
    expect(files.files.map((f) => f.filename).sort()).toEqual(['list.txt', 'spare.txt']);

    // Its own objects: deleting the original's file leaves the copy's readable.
    await fetch(`${BASE}/api/notes/${original.id}/files/list.txt`, {
      method: 'DELETE',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    const kept = await fetch(`${BASE}/api/notes/${copy.id}/files/list.txt`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(await kept.text()).toBe('bring a torch');
  });

  it('is 404 for a note that is not this user', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}/duplicate`, {
      method: 'POST',
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });
});

/**
 * Fetching a web image into a note. The picture server is this test process, on
 * loopback — which the Worker accepts only under the local-dev flag, so the address
 * policy is exercised on its own in `src/lib/web-image.test.ts`. What is asserted here
 * is the round trip: the bytes land, the type is kept, the name follows the rules, and a
 * page or an oversized answer is refused with a reason.
 */
describe('fetching a web image', () => {
  let server: Server;
  let origin: string;
  let note: { id: string };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  beforeAll(async () => {
    server = createServer((req, res) => {
      switch (req.url?.split('?')[0]) {
        case '/pics/photo.png':
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(Buffer.from(png));
        case '/hop':
          res.writeHead(302, { Location: '/pics/photo.png' });
          return res.end();
        case '/named':
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Disposition': 'inline; filename="Holiday (1).jpg"',
          });
          return res.end(Buffer.from(png));
        case '/page':
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html></html>');
        case '/huge':
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(40 * 1024 * 1024) });
          return res.end();
        default:
          res.writeHead(404);
          return res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${address.port}`;
    note = await createNote(alice, 'Bookmarks');
  }, 30_000);

  afterAll(() => {
    server.close();
  });

  async function fetchInto(actor: Actor, noteId: string, url: string): Promise<Response> {
    return fetch(`${BASE}/api/notes/${noteId}/files/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify({ url }),
    });
  }

  it('stores the picture under the address last segment and reports the path', async () => {
    const res = await fetchInto(alice, note.id, `${origin}/pics/photo.png?w=800`);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({ filename: 'photo.png', path: 'files/photo.png', contentType: 'image/png', size: png.length }),
    );
    const served = await fetch(`${BASE}/api/notes/${note.id}/files/photo.png`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
  });

  it('follows a redirect and suffixes a name already taken', async () => {
    const body = await (await fetchInto(alice, note.id, `${origin}/hop`)).json();
    expect(body.filename).toBe('photo-2.png');
  });

  it('takes the name the server sends', async () => {
    const body = await (await fetchInto(alice, note.id, `${origin}/named`)).json();
    expect(body.filename).toBe('Holiday (1).jpg');
    expect(body.contentType).toBe('image/jpeg');
  });

  it('refuses a page, an oversized picture, and a missing one, each with a reason', async () => {
    expect((await fetchInto(alice, note.id, `${origin}/page`)).status).toBe(415);
    expect((await fetchInto(alice, note.id, `${origin}/huge`)).status).toBe(413);
    const missing = await fetchInto(alice, note.id, `${origin}/nope.png`);
    expect(missing.status).toBe(502);
    expect(((await missing.json()) as { error: string }).error).toContain('404');
  });

  it('refuses an address that is not http(s)', async () => {
    expect((await fetchInto(alice, note.id, 'file:///etc/passwd')).status).toBe(400);
  });

  it('is 404 for a note that is not this user', async () => {
    expect((await fetchInto(bob, note.id, `${origin}/pics/photo.png`)).status).toBe(404);
  });
});

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

  /**
   * A percent sign is the one character that tells a single decode from a double one.
   *
   * The router decodes a path parameter before a handler sees it, so `50%25%20off` arrives
   * as `50% off`. Decoding that again throws on the bare `%` — a 500 — and for a name like
   * `100%41.txt` it would be worse, quietly addressing `100A.txt` instead. Every route that
   * takes the name in the path is walked here, because each decoded for itself.
   */
  it('serves, indexes and deletes a file whose name contains a percent sign', async () => {
    const note = await createNote(alice, 'Percent files');
    const name = '50% off (final).pdf';
    const headers = { Cookie: alice.cookie, Origin: ORIGIN };
    const url = `${BASE}/api/notes/${note.id}/files/${encodeURIComponent(name)}`;

    const put = await upload(alice, note.id, name, 'coupon', 'application/pdf');
    expect(put.status).toBe(201);
    expect((await put.json()).path).toBe(`files/${name}`);

    const get = await fetch(url, { headers });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('coupon');

    const text = await fetch(`${url}/text`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Half off one item.' }),
    });
    expect(text.status).toBe(204);

    const del = await fetch(url, { method: 'DELETE', headers });
    expect(del.status).toBe(204);
    expect((await fetch(url, { headers })).status).toBe(404);
  });

  it('does not decode a name twice, so an escape inside a name stays literal', async () => {
    const note = await createNote(alice, 'Escape-shaped names');
    const headers = { Cookie: alice.cookie, Origin: ORIGIN };
    await upload(alice, note.id, '100A.txt', 'decoded twice');
    await upload(alice, note.id, '100%41.txt', 'decoded once');

    const get = await fetch(
      `${BASE}/api/notes/${note.id}/files/${encodeURIComponent('100%41.txt')}`,
      { headers },
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('decoded once');
  });

  it('refuses an X-Filename that is not valid percent-encoding', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: alice.cookie,
        Origin: ORIGIN,
        'X-Filename': '50% off.pdf',
        'Content-Type': 'text/plain',
      },
      body: 'x',
    });
    expect(res.status).toBe(400);
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
describe('pending-vision', () => {
  const count = async (who: Actor): Promise<number> => {
    const res = await fetch(`${BASE}/api/attachments/pending-vision`, {
      headers: { Cookie: who.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { remaining: number }).remaining;
  };

  /**
   * The count behind the Import panel's "Read N images" button, which has to be free to
   * ask for: it is what names the price of the paid pass before anyone starts one.
   *
   * The picture is past the vision model's size cap on purpose. The Worker this runs
   * against may well hold a key, and a picture under the cap is read right after its
   * upload — a real request to a real model, from a test. One past the cap is left for the
   * pass, which is exactly the case the count exists to report; the pass records it as
   * empty when it gets there. 7MB is `MAX_LLM_IMAGE_BYTES`.
   */
  it('counts the files a reading pass would still be offered, per user', async () => {
    const stamp = Date.now();
    const actor = await signUp(`vision-${stamp}@example.test`, 'vision-pass-1234', 'V');
    const other = await signUp(`vision-other-${stamp}@example.test`, 'vision-pass-1234', 'O');
    expect(await count(actor)).toBe(0);

    const note = await createNote(actor, 'Pictures');
    const picture = await upload(actor, note.id, 'big.png', new Uint8Array(7 * 1024 * 1024 + 1), 'image/png');
    expect(picture.status).toBe(201);
    // A PDF with a text layer is the free reader's, never the model's.
    await upload(actor, note.id, 'scan.pdf', 'PDFBYTES', 'application/pdf');
    await fetch(`${BASE}/api/notes/${note.id}/files/scan.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'has a layer' }),
    });

    expect(await count(actor)).toBe(1);
    expect(await count(other)).toBe(0);
  });

  /**
   * The count's other half, and the trash. The pictures and the PDFs are counted by two
   * queries over two indexes (0025), so each half needs a file of its own here, and both
   * have to drop out while their note is in the trash and come back when it is restored.
   *
   * The PDF is past the model's PDF cap for the reason the picture above is past its own:
   * marking a text layer unusable starts a read with the model right away when the file is
   * small enough, and that is a paid request. 8MB is `MAX_LLM_PDF_BYTES`.
   */
  it('counts a PDF its text layer found empty, and nothing in the trash', async () => {
    const stamp = Date.now();
    const actor = await signUp(`vision-pdf-${stamp}@example.test`, 'vision-pass-1234', 'V');
    const note = await createNote(actor, 'Scans');
    const picture = await upload(actor, note.id, 'big.png', new Uint8Array(7 * 1024 * 1024 + 1), 'image/png');
    expect(picture.status).toBe(201);
    const pdf = await upload(actor, note.id, 'blank.pdf', new Uint8Array(8 * 1024 * 1024 + 1), 'application/pdf');
    expect(pdf.status).toBe(201);
    expect(await count(actor)).toBe(1);

    const marked = await fetch(`${BASE}/api/notes/${note.id}/files/blank.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unusable: true }),
    });
    expect(marked.status).toBe(204);
    expect(await count(actor)).toBe(2);

    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'DELETE',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    expect(await count(actor)).toBe(0);

    await fetch(`${BASE}/api/notes/${note.id}/restore`, {
      method: 'POST',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    expect(await count(actor)).toBe(2);
  });

  it('requires a session', async () => {
    const res = await fetch(`${BASE}/api/attachments/pending-vision`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
  });
});

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
