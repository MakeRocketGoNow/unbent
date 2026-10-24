import { describe, expect, it } from 'vitest';
import { serveFrontPage } from './front-pages.js';

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

const built = assets({ '/why.html': WHY_HTML, '/compare-joplin.html': COMPARE_HTML });

const get = (path: string, env: Parameters<typeof serveFrontPage>[1]) =>
  serveFrontPage(new Request(`https://notes.example.com${path}`), env);

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

  /** A link to the front page is unfurled from the shell, and a card's picture must be a whole address. */
  it('completes the shell’s addresses for the front routes that are the shell, with a front page or not', async () => {
    for (const path of ['/', '/pricing', '/support']) {
      for (const env of [
        { ASSETS: built, FRONT_PAGE: '1', APP_URL: 'https://unbent.example' },
        { ASSETS: built, APP_URL: 'https://unbent.example' },
      ]) {
        const response = await get(path, env);
        expect(response?.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        expect(await response!.text()).toContain('<meta property="og:image" content="https://unbent.example/front/card.png" />');
      }
    }
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
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://unbent.example/sitemap.xml');
    const sitemap = await get('/sitemap.xml', env);
    expect(sitemap?.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    const xml = await sitemap!.text();
    expect(xml).toContain('<loc>https://unbent.example/</loc>');
    expect(xml).toContain('<loc>https://unbent.example/why</loc>');
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
