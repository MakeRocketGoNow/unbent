/**
 * `POST /api/clip` against a live `wrangler dev`: a page fetched, read and kept as a
 * note, its pictures stored under the names the body already uses.
 *
 * The site is this test process, on loopback, which the Worker fetches only under the
 * local-dev flag; the address policy itself is `src/lib/clip.test.ts`'s and
 * `fetch-attachment.test.ts`'s. Every page and picture here is invented (Acme,
 * example.com), as AGENTS.md asks.
 *
 * This is also the check that the clip runs in workerd at all: `@unbent/clip` carries
 * linkedom and Readability into the Worker's bundle, and only a real request through the
 * bundle `wrangler dev` built shows that they load and parse there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FREE_NOTES } from '@unbent/shared';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

const PARAGRAPH =
  'An anvil that is looked after will outlast the smith who bought it. The face is hardened ' +
  'steel, meant to be struck by hot metal and a hammer, never by a cold chisel or a stray blow ' +
  'that misses the work and lands on the edge.';

const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);

const GUIDE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Caring for your anvil | Acme Workshop</title>
<meta property="og:site_name" content="Acme Workshop"></head>
<body>
  <header><nav><a href="/">Home</a> <a href="/shop">Shop the catalogue</a></nav></header>
  <article>
    <h1>Caring for your anvil</h1>
    <p class="byline">By Pat Example</p>
    <p>${PARAGRAPH}</p>
    <figure><img src="/pics/anvil.png" alt="A clean anvil face"></figure>
    <p>${PARAGRAPH} See <a href="/guides/edges">dressing the edges</a>.</p>
    <figure><img src="/pics/gone.png" alt="A chipped edge"></figure>
    <p>${PARAGRAPH}</p>
  </article>
  <aside><h3>Popular this week</h3><a href="/guides/tongs">Choosing tongs</a></aside>
  <footer>Copyright Acme Workshop.</footer>
</body></html>`;

interface Actor {
  cookie: string;
}

async function signUp(prefix: string): Promise<Actor> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: `${prefix}-${crypto.randomUUID()}@example.test`, password: 'clip-password-123', name: 'Clipper' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return { cookie: res.headers.getSetCookie().map((line) => line.split(';')[0]!).join('; ') };
}

function call(actor: Actor | null, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(actor ? { Cookie: actor.cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const hits: Record<string, number> = {};
let site: Server;
let origin: string;
let alice: Actor;

beforeAll(async () => {
  site = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    switch (path) {
      case '/guides/anvil':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(GUIDE);
      case '/pics/anvil.png':
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PICTURE.length });
        return res.end(Buffer.from(PICTURE));
      case '/manual.pdf':
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end('%PDF-1.4\n%%EOF\n');
      case '/members':
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('sign in first');
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not here');
    }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  alice = await signUp('clip-alice');
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

describe('POST /api/clip', () => {
  const id = crypto.randomUUID();

  it('keeps the article as a note with its picture stored, and the one that failed linked to the site', async () => {
    const res = await call(alice, 'POST', '/api/clip', { url: `${origin}/guides/anvil`, id, tags: ['clipped'] });
    expect(res.status).toBe(201);
    const note = (await res.json()) as {
      id: string;
      title: string;
      body: string;
      tags: string[];
      clip: { images: { stored: number; failed: Array<{ url: string; error: string }> } };
    };
    expect(note.id).toBe(id);
    expect(note.title).toBe('Caring for your anvil');
    expect(note.tags).toEqual(['clipped']);
    expect(note.clip.images.stored).toBe(1);
    expect(note.clip.images.failed).toEqual([{ url: `${origin}/pics/gone.png`, error: 'The site answered 404' }]);

    // The note as stored, not only as answered.
    const stored = (await (await call(alice, 'GET', `/api/notes/${id}`)).json()) as { body: string };
    expect(stored.body).toBe(note.body);
    expect(stored.body.startsWith(`Clipped from [Acme Workshop](${origin}/guides/anvil), by Pat Example`)).toBe(true);
    expect(stored.body).toContain('![A clean anvil face](files/anvil.png)');
    expect(stored.body).toContain(`![A chipped edge](${origin}/pics/gone.png)`);
    expect(stored.body).toContain(`[dressing the edges](${origin}/guides/edges)`);
    expect(stored.body).not.toContain('Popular this week');
    expect(stored.body).not.toContain('Shop the catalogue');

    const files = (await (await call(alice, 'GET', `/api/notes/${id}/files`)).json()) as {
      files: Array<{ filename: string; contentType: string }>;
    };
    expect(files.files.map((f) => [f.filename, f.contentType])).toEqual([['anvil.png', 'image/png']]);
    const served = await call(alice, 'GET', `/api/notes/${id}/files/anvil.png`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PICTURE);
  }, 30_000);

  it('answers a replay with the note it made, and fetches nothing again', async () => {
    const before = { page: hits['/guides/anvil'], picture: hits['/pics/anvil.png'] };
    const res = await call(alice, 'POST', '/api/clip', { url: `${origin}/guides/anvil`, id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(id);
    // The page is read again (the note's create is what knows the id is held) but no
    // picture is: the first request stored what it could.
    expect(hits['/pics/anvil.png']).toBe(before.picture);
    expect(hits['/guides/anvil']).toBe((before.page ?? 0) + 1);
  });

  it('takes the title, notebook and tags it is given', async () => {
    const notebook = `Clips ${Date.now()}`;
    const res = await call(alice, 'POST', '/api/clip', { url: `${origin}/guides/anvil`, title: 'Anvil care', notebook });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: 'Anvil care', notebook });
  }, 30_000);

  it('refuses a file, a refused page and a private address, each with a code', async () => {
    const pdf = await call(alice, 'POST', '/api/clip', { url: `${origin}/manual.pdf` });
    expect(pdf.status).toBe(415);
    expect(await pdf.json()).toMatchObject({ code: 'NOT_A_PAGE' });

    const members = await call(alice, 'POST', '/api/clip', { url: `${origin}/members` });
    expect(members.status).toBe(502);
    expect(await members.json()).toMatchObject({ code: 'HOST_REFUSED' });

    const inside = await call(alice, 'POST', '/api/clip', { url: 'http://10.0.0.1/admin' });
    expect(inside.status).toBe(400);
    expect(await inside.json()).toMatchObject({ code: 'BAD_URL' });

    expect((await call(alice, 'POST', '/api/clip', { url: '' })).status).toBe(400);
  });

  it('needs a session', async () => {
    expect((await call(null, 'POST', '/api/clip', { url: `${origin}/guides/anvil` })).status).toBe(401);
  });
});

/**
 * The plan's gate, where the dev server sells one (`STRIPE_*` in `.dev.vars`): an
 * account past the free plan is refused before the page is fetched, which is the
 * condition `HELD_IN_STORE` lists the route on.
 */
describe('POST /api/clip for an account past the free plan', () => {
  it('is refused before the page is fetched', async (ctx) => {
    const config = (await (await fetch(`${BASE}/api/config`)).json()) as { billing?: unknown };
    if (!config.billing) return ctx.skip();

    const bob = await signUp('clip-bob');
    // One more note than the free plan holds, made while the trial runs, ten at a time.
    for (let made = 0; made <= FREE_NOTES; made += 10) {
      const batch = Math.min(10, FREE_NOTES + 1 - made);
      const answers = await Promise.all(
        Array.from({ length: batch }, (_, i) => call(bob, 'POST', '/api/notes', { title: `Filler ${made + i}`, body: '' })),
      );
      for (const res of answers) expect(res.status).toBe(201);
    }
    const lapse = await call(bob, 'POST', '/api/admin/test/plan', { plan: 'trial', until: Date.now() - 1000 });
    expect(lapse.ok).toBe(true);

    const before = hits['/guides/anvil'] ?? 0;
    const refused = await call(bob, 'POST', '/api/clip', { url: `${origin}/guides/anvil` });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ code: 'PLAN_INACTIVE' });
    expect(hits['/guides/anvil'] ?? 0).toBe(before);
  }, 60_000);
});
