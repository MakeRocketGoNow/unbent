import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRERENDERED, hasSessionCookie, serveFrontPage } from './front-pages.js';

/**
 * The story's static copy as the build writes it: site-relative addresses in the head,
 * which only the Worker can complete, since only it knows the origin.
 */
const WHY_HTML = `<!doctype html><html><head>
<title>Why Unbent exists</title>
<link rel="canonical" href="/why" />
<meta property="og:url" content="/why" />
<meta property="og:image" content="/front/desktop-light.webp" />
</head><body><div id="root"><h1>Why Unbent exists</h1></div></body></html>`;

const SHELL =
  '<!doctype html><html><head><title>Unbent</title><meta property="og:image" content="/front/card.png" /></head><body><div id="root"></div></body></html>';

/** The `ASSETS` binding: the story's file, and the shell for everything else, as the SPA fallback answers. */
const assets = (files: Record<string, string>) =>
  ({
    fetch: async (input: Request | string) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const file = files[url.pathname];
      if (file) return new Response(file, { headers: { 'Content-Type': 'text/html', ETag: '"static"' } });
      if (url.pathname.endsWith('.html')) return new Response('Not found', { status: 404 });
      return new Response(SHELL, { headers: { 'Content-Type': 'text/html' } });
    },
  }) as unknown as Fetcher;

const COMPARE_HTML = WHY_HTML.replace(/Why Unbent exists/g, 'Unbent and Joplin').replace(/"\/why"/g, '"/compare/joplin"');

const FRONT_HTML = WHY_HTML.replace(/Why Unbent exists/g, 'Unbent').replace(/"\/why"/g, '"/"');

const built = assets({ '/why.html': WHY_HTML, '/compare-joplin.html': COMPARE_HTML, '/front-page.html': FRONT_HTML });

const get = (path: string, env: Parameters<typeof serveFrontPage>[1], headers?: HeadersInit) =>
  serveFrontPage(new Request(`https://notes.example.com${path}`, { headers }), env);

const SIGNED_IN = { Cookie: 'theme=dark; __Secure-better-auth.session_token=abc.def' };

/** A crawler's request: no `Sec-Fetch-Dest`, and an `Accept` that asks for HTML first. */
const CRAWLER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

describe('PRERENDERED', () => {
  /*
   * A page in the table reaches this module only if `run_worker_first` names it: for any
   * other path the asset layer answers first, and it resolves `/features` to
   * `features.html` on its own, raw, on every instance, forks with no front page included.
   * `/features` shipped that way once (2026-10-29), in the table and the sitemap and not
   * in the lists, which nothing checked. The service worker's own list is held to the toml
   * by `sw/routes.test.ts`, so between the two every prerendered page is tied through.
   */
  it('is handed to the Worker first, in every environment', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const toml = readFileSync(resolve(here, '../../wrangler.toml'), 'utf8');
    const blocks = [...toml.matchAll(/^\s*run_worker_first\s*=\s*\[([\s\S]*?)\]/gm)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, body] of blocks) {
      const entries = new Set([...body!.matchAll(/^\s*"([^"]+)"/gm)].map(([, path]) => path));
      for (const path of Object.keys(PRERENDERED)) expect(entries.has(path), path).toBe(true);
    }
  });
});

describe('serveFrontPage', () => {
  it('hands the story’s static copy over for /why, with its addresses completed from the origin', async () => {
    const response = await get('/why', { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' });
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await response!.text();
    expect(html).toContain('<title>Why Unbent exists</title>');
    expect(html).toContain('<link rel="canonical" href="https://unbent.example/why" />');
    expect(html).toContain('<meta property="og:url" content="https://unbent.example/why" />');
    expect(html).toContain('<meta property="og:image" content="https://unbent.example/front/desktop-light.webp" />');
  });

  /** The comparisons are written out the same way, each to a flat file of its own. */
  it('hands over a comparison’s static copy, and the shell on an instance with no front page', async () => {
    const html = await (await get('/compare/joplin', { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' }))!.text();
    expect(html).toContain('<title>Unbent and Joplin</title>');
    expect(html).toContain('<link rel="canonical" href="https://unbent.example/compare/joplin" />');
    const fork = await get('/compare/joplin', { ASSETS: built, APP_URL: 'https://notes.example.com' });
    expect(await fork!.text()).toBe(SHELL.replace('"/front/', '"https://notes.example.com/front/'));
  });

  it('completes the addresses from the request when no APP_URL is set', async () => {
    const html = await (await get('/why', { ASSETS: built, FRONT_PAGE: '1', APP_URL: '' }))!.text();
    expect(html).toContain('href="https://notes.example.com/why"');
  });

  /** A fork deployed unchanged tells nobody's story but its own: the shell, which the router sends to sign-in. */
  it('serves the shell for /why on an instance with no front page', async () => {
    const response = await get('/why', { ASSETS: built, APP_URL: 'https://notes.example.com' });
    expect(await response!.text()).toBe(SHELL.replace('"/front/', '"https://notes.example.com/front/'));
  });

  /** A `dist` built without the copy still draws the page: the app fills it in. */
  it('serves the shell when the build wrote no copy', async () => {
    const response = await get('/why', { ASSETS: assets({}), FRONT_PAGE: '1', APP_URL: 'https://notes.example.com' });
    expect(await response!.text()).toBe(SHELL.replace('"/front/', '"https://notes.example.com/front/'));
  });

  /**
   * A link to pricing is unfurled from the shell, and a card's picture must be a whole
   * address. The front page is the shell only for a signed-in request, hence the cookie.
   */
  it('completes the shell’s addresses for the front routes that are the shell, with a front page or not', async () => {
    for (const path of ['/', '/pricing', '/support']) {
      for (const env of [
        { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' },
        { ASSETS: built, APP_URL: 'https://unbent.example' },
      ]) {
        const response = await get(path, env, SIGNED_IN);
        expect(response?.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        expect(await response!.text()).toContain('<meta property="og:image" content="https://unbent.example/front/card.png" />');
      }
    }
  });

  /** What Google ranks for the name: the page itself, not an empty `#root`. */
  it('hands the front page’s static copy to a request with no session, and the shell to one with', async () => {
    const env = { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' };
    const visitor = await get('/', env, CRAWLER);
    expect(visitor?.headers.get('Vary')).toBe('Cookie, Sec-Fetch-Dest, Accept');
    const html = await visitor!.text();
    expect(html).toContain('<h1>Unbent</h1>');
    expect(html).toContain('<link rel="canonical" href="https://unbent.example/" />');
    const member = await get('/', env, SIGNED_IN);
    expect(member?.headers.get('Vary')).toBe('Cookie, Sec-Fetch-Dest, Accept');
    expect(await member!.text()).toBe(SHELL.replace('"/front/', '"https://unbent.example/front/'));
  });

  /**
   * The service worker's shell fill asks for `/index.html`, is redirected to `/`, and from a
   * signed-out visitor carries no cookie. What it stores is the offline answer for every
   * route, so it must be the shell, never the front page.
   */
  it('hands the shell to a script’s fetch of /, and the copy to a page load or a crawler', async () => {
    const env = { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' };
    const shell = SHELL.replace('"/front/', '"https://unbent.example/front/');
    expect(await (await get('/', env, { 'Sec-Fetch-Dest': 'empty' }))!.text()).toBe(shell);
    expect(await (await get('/', env, { 'Sec-Fetch-Dest': 'document' }))!.text()).toContain('<h1>Unbent</h1>');
    expect(await (await get('/', env, CRAWLER))!.text()).toContain('<h1>Unbent</h1>');
    // Safari before 16.4 sends no Sec-Fetch-Dest, so a script there is told apart by what it accepts.
    expect(await (await get('/', env, { Accept: '*/*' }))!.text()).toBe(shell);
    expect(await (await get('/', env))!.text()).toBe(shell);
  });

  /** The site's name and logo, as data, with whole addresses, on the front page alone. */
  it('adds the site’s structured data to the front page’s copy and nowhere else', async () => {
    const env = { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' };
    const html = await (await get('/', env, CRAWLER))!.text();
    const json = html.match(/<script type="application\/ld\+json">(.*?)<\/script>\n  <\/head>/)?.[1];
    expect(json).toBeDefined();
    const graph = JSON.parse(json!)['@graph'] as Record<string, unknown>[];
    expect(graph.find((node) => node['@type'] === 'WebSite')).toMatchObject({ name: 'Unbent', url: 'https://unbent.example/' });
    expect(graph.find((node) => node['@type'] === 'Organization')).toMatchObject({
      logo: 'https://unbent.example/icons/icon-512.png',
    });
    for (const [path, headers] of [['/', SIGNED_IN], ['/why', undefined]] as const) {
      expect(await (await get(path, env, headers))!.text()).not.toContain('application/ld+json');
    }
    const fork = await get('/', { ASSETS: built, APP_URL: 'https://notes.example.com' });
    expect(await fork!.text()).not.toContain('application/ld+json');
  });

  /** A fork deployed unchanged publishes nobody's offer, signed in or not. */
  it('serves the shell for / on an instance with no front page', async () => {
    const response = await get('/', { ASSETS: built, APP_URL: 'https://notes.example.com' });
    expect(await response!.text()).toBe(SHELL.replace('"/front/', '"https://notes.example.com/front/'));
  });

  it('answers nothing for every other path, and for a write', () => {
    expect(get('/notes', { ASSETS: built, FRONT_PAGE: '1', APP_URL: '' })).toBeNull();
    expect(get('/why.html', { ASSETS: built, FRONT_PAGE: '1', APP_URL: '' })).toBeNull();
    expect(get('/pricing/', { ASSETS: built, FRONT_PAGE: '1', APP_URL: '' })).toBeNull();
    expect(get('/compare/onenote', { ASSETS: built, FRONT_PAGE: '1', APP_URL: '' })).toBeNull();
    expect(
      serveFrontPage(new Request('https://notes.example.com/why', { method: 'POST' }), { ASSETS: built, FRONT_PAGE: '1', APP_URL: '' }),
    ).toBeNull();
  });

  it('lists the public pages for a crawler on production, and keeps it out of the app', async () => {
    const env = { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' };
    const robots = await (await get('/robots.txt', env))!.text();
    expect(robots).toContain('Disallow: /notes');
    expect(robots).toContain('Disallow: /api/');
    // The public pages' gate reads these before drawing; blocked, a crawler's render of
    // every public page was the sign-in screen.
    expect(robots).toContain('Allow: /api/config\n');
    expect(robots).toContain('Allow: /api/auth/get-session\n');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://unbent.example/sitemap.xml');
    const sitemap = await get('/sitemap.xml', env);
    expect(sitemap?.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    const xml = await sitemap!.text();
    expect(xml).toContain('<loc>https://unbent.example/</loc>');
    expect(xml).toContain('<loc>https://unbent.example/why</loc>');
    expect(xml).toContain('<loc>https://unbent.example/features</loc>');
    expect(xml).toContain('<loc>https://unbent.example/pricing</loc>');
    expect(xml).toContain('<loc>https://unbent.example/support</loc>');
    for (const app of ['', '/evernote', '/notion', '/joplin', '/paperless-ngx']) {
      expect(xml).toContain(`<loc>https://unbent.example/compare${app}</loc>`);
    }
    expect(xml).not.toContain('/notes');
  });

  /** Someone's private notes, or a scratch copy of the public site: neither is for a search index. */
  it('asks not to be indexed at all on an instance with no front page, or with a label', async () => {
    for (const env of [
      { ASSETS: built, APP_URL: 'https://notes.example.com' },
      { ASSETS: built, FRONT_PAGE: '1', INSTANCE_LABEL: 'Dev', APP_URL: 'https://dev.example.com' },
    ]) {
      expect(await (await get('/robots.txt', env))!.text()).toBe('User-agent: *\nDisallow: /\n');
      expect((await get('/sitemap.xml', env))?.status).toBe(404);
    }
  });
});

describe('hasSessionCookie', () => {
  const carries = (cookie: string) => hasSessionCookie(new Request('https://notes.example.com/', { headers: { Cookie: cookie } }));

  it('finds the session cookie under either name, anywhere in the header', () => {
    expect(carries('__Secure-better-auth.session_token=abc')).toBe(true);
    expect(carries('better-auth.session_token=abc')).toBe(true);
    expect(carries('ph_id=1; better-auth.session_token=abc; theme=dark')).toBe(true);
  });

  it('is not fooled by an empty value, a lookalike name or no header at all', () => {
    expect(carries('better-auth.session_token=')).toBe(false);
    expect(carries('better-auth.session_token=; theme=dark')).toBe(false);
    expect(carries('notbetter-auth.session_token=abc')).toBe(false);
    expect(carries('better-auth.session_data=abc')).toBe(false);
    expect(hasSessionCookie(new Request('https://notes.example.com/'))).toBe(false);
  });
});
