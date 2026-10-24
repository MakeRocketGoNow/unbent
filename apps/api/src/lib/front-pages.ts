import { frontPageOf } from './instance.js';
import { instanceLabelOf } from '../routes/auth.js';
import type { RawEnv } from '../types.js';

/**
 * The pages for people who are not signed in, as a crawler and a link preview see them
 * (MAK-240): the static copies of the story and the comparisons, the front page's shell,
 * `robots.txt` and the sitemap.
 *
 * Every other path is the web app's shell, which the `ASSETS` binding serves for any
 * address without a file, and which says "Unbent" and the front page's sentence whatever
 * the route. The app rewrites the head once it runs (`page-meta.ts`), but a link's card
 * is drawn by something that runs no script, and a search result is indexed from what
 * arrives. So the build writes the story out as `why.html` (`prerender.tsx` in the web
 * app), and the Worker hands that file over for `/why`, ahead of Hono as the manifest is
 * (`lib/manifest.ts`), so the pass costs an asset read and not a session lookup.
 *
 * The Worker is in the path, rather than the file being served as any other asset, for
 * two reasons. The file names its origin nowhere, because the build does not know it: a
 * card's picture has to be an absolute address, and the page's canonical address too, so
 * the site-relative ones the build wrote are completed here from the origin the instance
 * is served on. And a fork deployed unchanged must not tell unbent.app's story under its
 * own name: on an instance with no front page (`FRONT_PAGE`), `/why` is the shell, which
 * the app's router sends to the sign-in screen as it does `/pricing`.
 *
 * `robots.txt` and the sitemap follow the same flag. An instance with no front page is
 * someone's private notes and asks not to be indexed at all; one with a front page lists
 * the pages for people who are not signed in and keeps the crawler out of the app behind
 * the sign-in. A scratch instance (dev, a preview) wears a label, and asks not to be
 * indexed either, or a search for the story would find three copies of it.
 */

/** The address the story is served at. */
export const WHY_PATH = '/why';

/**
 * Every page the build writes a static copy of, and the file it wrote it to: the story
 * and the comparisons (`PAGES` in the web app's `prerender.tsx`, which this must match).
 * Flat file names rather than a `compare/` directory, so no path the asset layer would
 * resolve on its own ever lands on one of them.
 */
export const PRERENDERED: Readonly<Record<string, string>> = {
  [WHY_PATH]: '/why.html',
  '/compare': '/compare.html',
  '/compare/evernote': '/compare-evernote.html',
  '/compare/notion': '/compare-notion.html',
  '/compare/joplin': '/compare-joplin.html',
  '/compare/paperless-ngx': '/compare-paperless-ngx.html',
};

/** The pages under the front page's shell, in the order the sitemap lists them. */
export const FRONT_ROUTES = ['/', ...Object.keys(PRERENDERED), '/pricing', '/support'] as const;

/**
 * The front routes with no static copy of their own, which are the shell itself. They pass
 * through here only so the card's picture in the shell's head is a whole address: left to
 * the asset layer, a link to the front page unfurled in Slack with no picture, because
 * the shell names it as `/front/…` and a card is drawn by something that resolves nothing.
 * The rest of the app's routes stay with the asset layer: they are behind the sign-in,
 * and a card for one of them has nothing to show anyway.
 */
const SHELL_ROUTES: ReadonlySet<string> = new Set(['/', '/pricing', '/support']);

/** The app behind the sign-in, which a crawler has no business in even when it follows a link there. */
const PRIVATE_PREFIXES = ['/api/', '/notes', '/trash', '/settings', '/import', '/login', '/connect', '/consent', '/device', '/embed/'];

/** The entry point's env, before `withAppUrl` has settled `APP_URL`; hence the fallback below. */
type FrontEnv = Pick<RawEnv, 'ASSETS' | 'FRONT_PAGE' | 'INSTANCE_LABEL' | 'APP_URL'>;

/**
 * Answers the paths above, or `null` for every other request so the entry point
 * passes it on. `APP_URL` is the origin the addresses are completed with when it is set,
 * since that is the one address the operator chose; failing that, the one the request
 * arrived on, which on Workers is one that routes here and so is also theirs.
 */
export function serveFrontPage(request: Request, env: FrontEnv): Promise<Response> | Response | null {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const origin = env.APP_URL?.trim() ? new URL(env.APP_URL).origin : url.origin;
  const indexable = Boolean(frontPageOf(env)) && !instanceLabelOf(env);
  if (url.pathname === '/robots.txt') return text(robotsTxt(indexable, origin));
  if (url.pathname === '/sitemap.xml') {
    return indexable ? text(sitemapXml(origin), 'application/xml') : new Response('Not found', { status: 404 });
  }
  const file = PRERENDERED[url.pathname];
  if (file) return servePrerendered(request, env, origin, file);
  if (SHELL_ROUTES.has(url.pathname)) return serveShell(request, env, origin);
  return null;
}

/**
 * The shell, with the addresses in its head completed. On every instance, with a front
 * page or not: the shell is the same file either way, and a whole address is right on
 * both. Asked for as a plain GET, for the reason `servePrerendered` gives.
 */
async function serveShell(request: Request, env: FrontEnv, origin: string): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  if (!asset.ok) return asset;
  return html(completeAddresses(await asset.text(), origin));
}

/**
 * A page's static copy, with its addresses completed; or the shell, on an instance
 * with no front page, and when the build wrote no copy (a dev Worker over a `dist` built
 * without it), so the page still draws and the app fills it in as it does every other
 * route.
 *
 * The shell is asked for as `/`, not as the request: the binding resolves `/why` to
 * `why.html` on its own, which is the file a fork must not serve, and answers
 * `/index.html` with a redirect to `/`.
 */
async function servePrerendered(request: Request, env: FrontEnv, origin: string, file: string): Promise<Response> {
  const shell = () => serveShell(request, env, origin);
  if (!frontPageOf(env)) return shell();
  // A plain GET, not the browser's conditional one: the file's ETag describes the file,
  // not this answer with its addresses completed.
  const asset = await env.ASSETS.fetch(new Request(new URL(file, request.url)));
  if (!asset.ok) return shell();
  return html(completeAddresses(await asset.text(), origin));
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The shell's own rule: a page load is always the newest build.
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * The site-relative addresses in a prerendered page's head, made absolute: the card's
 * picture and the page's own address, which the Open Graph protocol wants whole. On the
 * text rather than through `HTMLRewriter`, because the head is a few tags the build wrote
 * in a known shape, the page is a few kilobytes, and the unit tests run in Node, where
 * the rewriter does not exist.
 */
export function completeAddresses(html: string, origin: string): string {
  return html
    .replace(/(<meta property="og:(?:image|url)" content=")(\/[^"]*)/g, `$1${origin}$2`)
    .replace(/(<link rel="canonical" href=")(\/[^"]*)/g, `$1${origin}$2`);
}

/** What a crawler may read here: the public pages, or nothing. */
export function robotsTxt(indexable: boolean, origin: string): string {
  if (!indexable) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    ...PRIVATE_PREFIXES.map((prefix) => `Disallow: ${prefix}`),
    'Allow: /',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * The public pages, with no dates: each is edited when the product changes and none is
 * a post, so a `lastmod` would be a date nobody maintains. The legal documents are
 * left out: they are reachable and indexable, but not what anyone searches for.
 */
export function sitemapXml(origin: string): string {
  const urls = FRONT_ROUTES.map((route) => `  <url><loc>${origin}${route === '/' ? '/' : route}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

function text(body: string, type = 'text/plain'): Response {
  return new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' } });
}
