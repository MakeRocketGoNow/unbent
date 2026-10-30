import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentFilenamesInMarkdown, type Note } from '@unbent/shared';
import { clipUrl, decodeHtml, relink } from './clip.js';
import { StorageFull } from './quota.js';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { NotesRepo } from './notes-repo.js';

/**
 * The server's clip with the network and the store stood in for: what is fetched, in
 * what order, and what is written. The page is invented (Acme, example.com), long enough
 * for Readability to call it an article, with the chrome around it a clip leaves behind.
 */

const PARAGRAPH =
  'A forge that is lit slowly lasts longer than one brought up to heat in a hurry. Start ' +
  'the fire small, with dry kindling under a loose bed of coke, and feed the air gently ' +
  'until the whole bed glows evenly from one side to the other before any work goes in.';

function articlePage(pictures: string[]): string {
  const figures = pictures.map((src, i) => `<p>${PARAGRAPH}</p><figure><img src="${src}" alt="Step ${i + 1}"></figure>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lighting a forge | Acme Workshop</title>
<meta property="og:site_name" content="Acme Workshop"></head>
<body>
  <header><nav><a href="/">Home</a> <a href="/shop">Shop</a></nav></header>
  <article>
    <h1>Lighting a forge</h1>
    <p>${PARAGRAPH}</p>
    ${figures.join('\n')}
    <p>${PARAGRAPH}</p>
    <p>${PARAGRAPH}</p>
  </article>
  <footer>Copyright Acme Workshop.</footer>
</body></html>`;
}

const PAGE_URL = 'https://example.com/guides/forge';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

type Route = () => Response;

/** A web of fixed answers, recording every address asked for. */
function stubWeb(routes: Record<string, Route>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    const route = routes[url];
    return route ? route() : new Response('not found', { status: 404 });
  });
  return asked;
}

const html = (body: string): Route => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const png: Route = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

/** Notes, files and R2 just far enough to watch: what was created, put, recorded and updated. */
function fakeStore(opts: { refuseFiles?: boolean; existing?: boolean } = {}) {
  const created: Array<{ id: string; title: string; body: string }> = [];
  const updates: Array<{ id: string; patch: { body?: string; ifUpdatedAt?: number } }> = [];
  const puts: string[] = [];
  const deleted: string[] = [];
  const recorded: string[] = [];

  const asNote = (input: { id: string; title: string; body: string }) =>
    ({ id: input.id, title: input.title, body: input.body, tags: [], createdAt: 1, updatedAt: 1, deletedAt: null }) as unknown as Note;

  const notes = {
    createOrFind: async (input: { id: string; title: string; body: string }) => {
      created.push(input);
      return { note: asNote(input), existing: opts.existing ?? false };
    },
    update: async (id: string, patch: { body?: string; ifUpdatedAt?: number }) => {
      updates.push({ id, patch });
      return asNote({ ...created[0]!, body: patch.body ?? created[0]!.body });
    },
  } as unknown as NotesRepo;

  const attachments = {
    availableFilename: async (_noteId: string, name: string) => name,
    buildKey: (noteId: string, id: string, name: string) => `users/u/notes/${noteId}/files/${id}-${name}`,
    record: async (row: { id: string; filename: string; contentType: string; size: number }) => {
      if (opts.refuseFiles) throw new StorageFull(1024, 1024, row.size);
      recorded.push(row.filename);
      return { id: row.id, filename: row.filename, contentType: row.contentType, size: row.size, createdAt: 1 };
    },
  } as unknown as AttachmentsRepo;

  const env = {
    BLOBS: {
      put: async (key: string, body: ArrayBuffer) => {
        puts.push(key);
        return { size: body.byteLength };
      },
      delete: async (key: string) => {
        deleted.push(key);
      },
    },
  } as never;

  return { env, repos: { notes, attachments }, created, updates, puts, deleted, recorded };
}

const ctx = { waitUntil() {} };
const options = { allowLoopback: false, quota: null };

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clipUrl', () => {
  it('writes the note once and stores each picture under the name its body already uses', async () => {
    const asked = stubWeb({
      [PAGE_URL]: html(articlePage(['/media/coke-bed.png', 'https://cdn.example.com/air.png'])),
      'https://example.com/media/coke-bed.png': png,
      'https://cdn.example.com/air.png': png,
    });
    const store = fakeStore();

    const result = await clipUrl(store.env, ctx, store.repos, { url: PAGE_URL }, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toEqual({ stored: 2, failed: [] });
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.title).toBe('Lighting a forge');
    const body = store.created[0]!.body;
    expect(body).toMatch(/^Clipped from \[Acme Workshop\]\(https:\/\/example\.com\/guides\/forge\)/);
    expect(body).not.toContain('Shop');
    expect([...attachmentFilenamesInMarkdown(body)].sort()).toEqual(['air.png', 'coke-bed.png']);
    expect(store.recorded.sort()).toEqual(['air.png', 'coke-bed.png']);
    expect(store.puts).toHaveLength(2);
    // Nothing failed, so the body the create wrote stands: no second write, no history.
    expect(store.updates).toEqual([]);
    expect(asked).toHaveLength(3);
  });

  it('points a picture that could not be fetched back at the web, in the one repair write', async () => {
    stubWeb({
      [PAGE_URL]: html(articlePage(['/media/coke-bed.png', '/media/gone.png'])),
      'https://example.com/media/coke-bed.png': png,
    });
    const store = fakeStore();

    const result = await clipUrl(store.env, ctx, store.repos, { url: PAGE_URL, title: 'My forge notes' }, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.created[0]!.title).toBe('My forge notes');
    expect(result.images.stored).toBe(1);
    expect(result.images.failed).toEqual([{ url: 'https://example.com/media/gone.png', error: 'The site answered 404' }]);
    expect(store.updates).toHaveLength(1);
    const { patch } = store.updates[0]!;
    // Against the note as created, so an edit made meanwhile is not overwritten.
    expect(patch.ifUpdatedAt).toBe(1);
    expect(patch.body).toContain('![Step 2](https://example.com/media/gone.png)');
    expect([...attachmentFilenamesInMarkdown(patch.body!)]).toEqual(['coke-bed.png']);
    expect(result.note.body).toBe(patch.body);
  });

  it('refuses an address on a private network before anything is fetched', async () => {
    const asked = stubWeb({});
    const store = fakeStore();
    const result = await clipUrl(store.env, ctx, store.repos, { url: 'http://10.0.0.5/admin' }, options);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'BAD_URL' });
    expect(asked).toEqual([]);
    expect(store.created).toEqual([]);
  });

  it('answers a file that is not a page with a 415 that says how files are attached', async () => {
    stubWeb({ [PAGE_URL]: () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }) });
    const store = fakeStore();
    const result = await clipUrl(store.env, ctx, store.repos, { url: PAGE_URL }, options);
    expect(result).toMatchObject({ ok: false, status: 415, code: 'NOT_A_PAGE' });
    if (!result.ok) expect(result.error).toContain('add_attachment');
    expect(store.created).toEqual([]);
  });

  it('says a host refused this server, so the caller can read the page itself', async () => {
    stubWeb({ [PAGE_URL]: () => new Response('denied', { status: 403 }) });
    const store = fakeStore();
    const result = await clipUrl(store.env, ctx, store.repos, { url: PAGE_URL }, options);
    expect(result).toMatchObject({ ok: false, status: 502, code: 'HOST_REFUSED' });
  });

  it('stops fetching pictures at the first refusal for room, and says why for the rest', async () => {
    const pictures = Array.from({ length: 7 }, (_, i) => `/media/step-${i + 1}.png`);
    const routes: Record<string, Route> = { [PAGE_URL]: html(articlePage(pictures)) };
    for (const p of pictures) routes[`https://example.com${p}`] = png;
    const asked = stubWeb(routes);
    const store = fakeStore({ refuseFiles: true });

    const result = await clipUrl(store.env, ctx, store.repos, { url: PAGE_URL }, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images.stored).toBe(0);
    expect(result.images.failed).toHaveLength(7);
    expect(new Set(result.images.failed.map((f) => f.error)).size).toBe(1);
    expect(result.images.failed[0]!.error).toMatch(/storage/i);
    // Four in flight when the first was refused, and none fetched after: pictures five to
    // seven were never asked for. Those in flight may each have reached R2 before the
    // refusal came back, and every object refused is deleted again (`storeAttachment`).
    const pictureFetches = asked.filter((u) => u !== PAGE_URL);
    expect(pictureFetches).toHaveLength(4);
    expect(pictureFetches).not.toContain('https://example.com/media/step-5.png');
    expect(store.deleted.sort()).toEqual(store.puts.sort());
    const body = store.updates[0]!.patch.body!;
    expect(attachmentFilenamesInMarkdown(body).size).toBe(0);
    expect(body).toContain('(https://example.com/media/step-7.png)');
  });

  it('reads a page whose weight is its scripts, and refuses one too large to parse', async () => {
    const bulky = articlePage([]).replace('</head>', `<script>${'var a = 1;'.repeat(200_000)}</script></head>`);
    stubWeb({ [PAGE_URL]: html(bulky) });
    const first = fakeStore();
    expect((await clipUrl(first.env, ctx, first.repos, { url: PAGE_URL }, options)).ok).toBe(true);

    const long = articlePage([]).replace('</article>', `${`<p>${PARAGRAPH}</p>`.repeat(5000)}</article>`);
    stubWeb({ [PAGE_URL]: html(long) });
    const store = fakeStore();
    const result = await clipUrl(store.env, ctx, store.repos, { url: PAGE_URL }, options);
    expect(result).toMatchObject({ ok: false, status: 413, code: 'TOO_LARGE' });
    expect(store.created).toEqual([]);
  });

  it('answers a replayed clip with the note it made, without fetching its pictures again', async () => {
    const asked = stubWeb({
      [PAGE_URL]: html(articlePage(['/media/coke-bed.png'])),
      'https://example.com/media/coke-bed.png': png,
    });
    const store = fakeStore({ existing: true });
    const id = '11111111-1111-4111-8111-111111111111';
    const result = await clipUrl(store.env, ctx, store.repos, { url: PAGE_URL, id }, options);
    expect(result).toMatchObject({ ok: true, existing: true, images: { stored: 0, failed: [] } });
    expect(store.created[0]!.id).toBe(id);
    expect(asked).toEqual([PAGE_URL]);
  });

  it('asks whether the account is past the free plan before fetching anything', async () => {
    const asked = stubWeb({ [PAGE_URL]: html(articlePage([])) });
    const store = fakeStore();
    const refused = new Error('read-only');
    await expect(
      clipUrl(store.env, ctx, store.repos, { url: PAGE_URL }, { ...options, pastFree: async () => Promise.reject(refused) }),
    ).rejects.toBe(refused);
    expect(asked).toEqual([]);
  });
});

describe('relink', () => {
  const images = [
    { url: 'https://example.com/a/Step%20(1).png', path: 'files/Step (1).png', filename: 'Step (1).png', alt: 'One [of] two' },
    { url: 'https://example.com/a/a&copy;b.png', path: 'files/a&copy;b.png', filename: 'a&copy;b.png', alt: 'Two' },
    { url: 'https://example.com/a/kept.png', path: 'files/kept.png', filename: 'kept.png', alt: 'Kept' },
  ];
  const body = [
    'Clipped from [Acme](https://example.com/a)',
    '',
    '![One \\[of\\] two](<files/Step (1).png> "A title")',
    '',
    '![Two](files/a\\&copy;b.png)',
    '',
    '```',
    '![Two](files/a\\&copy;b.png)',
    '```',
    '',
    '![Kept](files/kept.png)',
  ].join('\n');

  it('replaces only the destination of each picture named, in links and not in code', () => {
    const out = relink(
      body,
      images,
      new Map([
        ['Step (1).png', 'https://example.com/a/Step%20(1).png'],
        ['a&copy;b.png', 'https://example.com/a/a&copy;b.png'],
      ]),
    );
    expect(out).toContain('![One \\[of\\] two](<https://example.com/a/Step%20(1).png> "A title")');
    expect(out).toContain('![Two](https://example.com/a/a\\&copy;b.png)\n');
    // The code block quoting the same link is text, not a link, and stays as it was.
    expect(out).toContain('```\n![Two](files/a\\&copy;b.png)\n```');
    expect([...attachmentFilenamesInMarkdown(out)]).toEqual(['kept.png']);
  });

  it('points a renamed picture at the name it was stored under', () => {
    const out = relink(body, images, new Map([['kept.png', 'files/kept (2).png']]));
    expect(out).toContain('![Kept](<files/kept (2).png>)');
  });
});

describe('decodeHtml', () => {
  const bytes = (...b: number[]) => new Uint8Array(b).buffer;

  it('decodes in the charset the header names', () => {
    expect(decodeHtml(bytes(0x63, 0x61, 0x66, 0xe9), 'text/html; charset=ISO-8859-1')).toBe('café');
  });

  it('falls back to a meta charset in the head, then to UTF-8', () => {
    const page = new TextEncoder().encode('<meta charset="windows-1252"><p>caf');
    const withE = new Uint8Array([...page, 0xe9]);
    expect(decodeHtml(withE.buffer, 'text/html')).toContain('café');
    expect(decodeHtml(new TextEncoder().encode('<p>café</p>').buffer as ArrayBuffer, 'text/html')).toBe('<p>café</p>');
    expect(decodeHtml(new TextEncoder().encode('ok').buffer as ArrayBuffer, 'text/html; charset=not-a-charset')).toBe('ok');
  });
});
