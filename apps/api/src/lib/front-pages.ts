import { OPERATOR_PLACEHOLDER } from '@unbent/shared';
import { frontPageOf, operatorContactOf } from './instance.js';
import { instanceLabelOf } from '../routes/auth.js';
import type { RawEnv } from '../types.js';

/**
 * The pages for people who are not signed in, as a crawler and a link preview see them
 * (MAK-240): the static copies of the front page, the story, the features page, the
 * comparisons, pricing and support, `robots.txt` and the sitemap.
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
 * the app's router sends to the sign-in screen.
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
 * Every page the build writes a static copy of, and the file it wrote it to: the story,
 * the features page, the comparisons, pricing and support (`PAGES` in the web app's
 * `prerender.tsx`, which this must match).
 *
 * Flat file names rather than a `compare/` directory keep each copy off its page's own
 * address. They do not keep the asset layer away from it: that answers the file's name
 * without `.html` (`/compare-joplin`, `/front-page`) on its own, raw, before the Worker
 * runs, so every copy is reachable there on every instance, a fork with no front page
 * included. Left so on 2026-11-05: nothing links to those addresses, the copy names its
 * real address as canonical, and sending them through the Worker means `run_worker_first`
 * entries, which the service worker's lists and the compat contract are tied to.
 */
export const PRERENDERED: Readonly<Record<string, string>> = {
  [WHY_PATH]: '/why.html',
  '/features': '/features.html',
  '/compare': '/compare.html',
  '/compare/evernote': '/compare-evernote.html',
  '/compare/notion': '/compare-notion.html',
  '/compare/joplin': '/compare-joplin.html',
  '/compare/paperless-ngx': '/compare-paperless-ngx.html',
  '/pricing': '/pricing.html',
  '/support': '/support.html',
};

/**
 * The copies a signed-in person reads as often as a visitor: pricing, and support, which a
 * receipt links to. Each was rendered with no session, so it offers the trial and says
 * Sign in, where the app draws "Open your notes" and "Your notes"; drawn to a signed-in
 * reader, the way out would change shape under them once the app ran. Their routes ask for
 * the session first precisely so the page draws once, and a request with a session cookie
 * gets the shell, which keeps that, as `/` does (`hasSessionCookie`). Crawlers and link
 * previews carry no cookie, so they still read the copy. The story and the other copies
 * are left as they were: only their header's link changes, and they are read signed out.
 */
const READ_SIGNED_IN: ReadonlySet<string> = new Set(['/pricing', '/support']);

/**
 * The front page's static copy (`PAGES['/']` in the web app's `prerender.tsx`). Not in
 * `PRERENDERED`, because `/` is also the way into the notes, and a signed-in load of it
 * must be the shell rather than the front page drawn for a moment before the router
 * moves on: see `hasSessionCookie`.
 */
export const FRONT_FILE = '/front-page.html';

/** The pages under the front page's shell, in the order the sitemap lists them. */
export const FRONT_ROUTES = ['/', ...Object.keys(PRERENDERED)] as const;

/** The app behind the sign-in, which a crawler has no business in even when it follows a link there. */
const PRIVATE_PREFIXES = ['/api/', '/notes', '/trash', '/settings', '/import', '/login', '/connect', '/consent', '/device', '/embed/'];

/**
 * The two reads under `/api/` that every public page makes before it draws: the route's
 * gate asks the config whether this instance has a front page, and the session whether to
 * send the reader on to their notes. A crawler obeys robots.txt for a page's own requests
 * too, so with these behind `Disallow: /api/` Google's renderer never got the config, the
 * gate sent it to the sign-in screen, and every public page rendered as a blank sign-in
 * page in its live test, the static copy the Worker had sent replaced by the app
 * (2026-10-17 to 2026-11-09). The longer rule wins, so these beat the prefix; both answer
 * a signed-out reader with nothing private. A new read in a public route's gate belongs
 * here too.
 */
const PUBLIC_READS = ['/api/config', '/api/auth/get-session'];

/** The entry point's env, before `withAppUrl` has settled `APP_URL`; hence the fallback below. */
type FrontEnv = Pick<RawEnv, 'ASSETS' | 'FRONT_PAGE' | 'INSTANCE_LABEL' | 'APP_URL' | 'OPERATOR_NAME' | 'OPERATOR_EMAIL'>;

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
  if (url.pathname === '/') {
    return varyOnRequester(
      hasSessionCookie(request) || !isDocumentLoad(request)
        ? serveShell(request, env, origin)
        : servePrerendered(request, env, origin, FRONT_FILE, structuredData(origin)),
    );
  }
  const file = PRERENDERED[url.pathname];
  if (!file) return null;
  if (READ_SIGNED_IN.has(url.pathname)) {
    return varyOnRequester(hasSessionCookie(request) ? serveShell(request, env, origin) : servePrerendered(request, env, origin, file));
  }
  return servePrerendered(request, env, origin, file);
}

/**
 * Whether the request carries a session cookie: Better Auth's `session_token`, which is
 * `__Secure-better-auth.session_token` over https and `better-auth.session_token` on
 * localhost (`useSecureCookies` in `auth.ts`).
 *
 * Its presence only, never its validity: looking the session up would cost the front
 * page a D1 read on every load, for a choice between two pages that are both right. A
 * cookie whose session has lapsed gets the shell, which draws the front page once the
 * router has asked, as every load of `/` did before the static copy. A crawler, a link
 * preview and a first visit carry no cookie and get the copy. Signing out clears the
 * cookie, so the next load of `/` is the copy too.
 */
export function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get('Cookie');
  return Boolean(cookie && /(?:^|;)\s*(?:__Secure-)?better-auth\.session_token=[^;\s]/.test(cookie));
}

/**
 * Whether the request could be a page load: a browser says `document` for one. Anything
 * else is a script's `fetch()`, and the one that matters is the service worker's shell
 * fill (`fillShell` in `sw/sw.ts`): it asks for `/index.html`, which the asset layer
 * redirects here, and a signed-out visitor's worker carries no session cookie. Without
 * this check the fill stored the front page's copy as the offline shell of every route,
 * and a signed-in person offline was shown the front page in place of their notes until
 * the next deploy.
 *
 * With no `Sec-Fetch-Dest` at all it is a page load if it asks for HTML. Crawlers send
 * no such header and do ask (Googlebot's `Accept` leads with `text/html`), and so does a
 * page load in Safari before 16.4, which sent none of the `Sec-Fetch-*` headers; a
 * script's `fetch()` there accepts any type without naming HTML and gets the shell. So
 * does a crawler or an unfurler that asks the same way, which is what every load of `/`
 * got before the copy: no worse than it was, and a card reads the same picture and
 * description. Marking the shell fill's own request instead would let those have the
 * copy, but that is a change to the service worker, and this was not worth one.
 */
function isDocumentLoad(request: Request): boolean {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest !== null) return dest === 'document';
  return /text\/html/i.test(request.headers.get('Accept') ?? '');
}

/**
 * The answer for `/`, `/pricing` and `/support`, marked as depending on the cookie (and,
 * for `/`, on what asked), so nothing between here and the browser hands one requester's
 * page to another. One header for all three: a cache that varies on more than it needs
 * to only stores more copies. The asset layer's own answer (a failed read) has headers
 * that cannot be changed, hence the copy.
 */
async function varyOnRequester(answer: Promise<Response>): Promise<Response> {
  const settled = await answer;
  const response = new Response(settled.body, settled);
  response.headers.append('Vary', 'Cookie, Sec-Fetch-Dest, Accept');
  return response;
}

/**
 * The shell, with the addresses in its head completed: for a front page that cannot be
 * served as its copy, and for `/`, `/pricing` and `/support` with a session
 * (`READ_SIGNED_IN`). A card's picture must be a whole address: left to the asset layer,
 * a link unfurled in Slack with no picture, because the shell names it as `/front/…` and
 * a card is drawn by something that resolves nothing. Asked for as a plain GET, for the
 * reason `servePrerendered` gives.
 */
async function serveShell(request: Request, env: FrontEnv, origin: string): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  if (!asset.ok) return asset;
  return html(completeAddresses(await asset.text(), origin));
}

/**
 * A page's static copy, with its addresses completed and `head` added to its head; or
 * the shell, on an instance with no front page, when the build wrote no copy (a dev
 * Worker over a `dist` built without it), and when the copy names an operator this
 * instance has none of (`fillOperator`), so the page still draws and the app fills it
 * in as it does every other route.
 *
 * The shell is asked for as `/`, not as the request: the binding resolves `/why` to
 * `why.html` on its own, which is the file a fork must not serve, and answers
 * `/index.html` with a redirect to `/`.
 */
async function servePrerendered(request: Request, env: FrontEnv, origin: string, file: string, head = ''): Promise<Response> {
  const shell = () => serveShell(request, env, origin);
  if (!frontPageOf(env)) return shell();
  // A plain GET, not the browser's conditional one: the file's ETag describes the file,
  // not this answer with its addresses completed.
  const asset = await env.ASSETS.fetch(new Request(new URL(file, request.url)));
  if (!asset.ok) return shell();
  const filled = fillOperator(await asset.text(), env);
  if (filled === null) return shell();
  const page = completeAddresses(filled, origin);
  return html(head ? page.replace('</head>', `${head}\n  </head>`) : page);
}

/**
 * A copy's operator placeholders (`OPERATOR_PLACEHOLDER`, written by the build into the
 * support page) replaced with this instance's own, under the rule the config answers by
 * (`operatorContactOf`), so the copy names exactly the operator the app then draws. A
 * copy with no placeholder comes back as it was. `null` where the copy has one and the
 * instance names no operator: the app draws such a page without one, in words the copy
 * does not have, so the shell is the answer that does not change under the reader.
 */
export function fillOperator(page: string, env: Pick<RawEnv, 'OPERATOR_NAME' | 'OPERATOR_EMAIL'>): string | null {
  if (!page.includes(OPERATOR_PLACEHOLDER.name) && !page.includes(OPERATOR_PLACEHOLDER.email)) return page;
  const operator = operatorContactOf(env);
  if (!operator) return null;
  return page
    .replaceAll(OPERATOR_PLACEHOLDER.name, escapeHtml(operator.name))
    .replaceAll(OPERATOR_PLACEHOLDER.email, escapeHtml(operator.email));
}

/** For text and attribute values alike: every placeholder sits in one or the other. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

/**
 * What the front page tells a search engine about the site as data rather than prose:
 * that the site is called Unbent, and what its logo is. Google reads `WebSite` from the
 * home page for the name it heads every result with, which is otherwise guessed and was
 * "unbent.app", and `Organization` for the logo and the profiles that are the same
 * thing (`sameAs`), the source repository today; a store listing or a social profile
 * belongs in that list once there is a public one.
 *
 * Written here rather than by the build because every address in it has to be whole,
 * and only the Worker knows the origin. Only on the front page's static copy, which only
 * an instance with a front page serves: the name, the logo and the repository are
 * unbent.app's, as the page's prices are, and a fork with no front page claims none of
 * them. The `<` escape keeps a value from ever closing the script tag.
 */
export function structuredData(origin: string): string {
  const site = `${origin}/`;
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${site}#website`, name: 'Unbent', url: site, publisher: { '@id': `${site}#organization` } },
      {
        '@type': 'Organization',
        '@id': `${site}#organization`,
        name: 'Unbent',
        url: site,
        logo: `${origin}/icons/icon-512.png`,
        sameAs: ['https://github.com/MakeRocketGoNow/unbent'],
      },
    ],
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/** What a crawler may read here: the public pages, or nothing. */
export function robotsTxt(indexable: boolean, origin: string): string {
  if (!indexable) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    ...PRIVATE_PREFIXES.map((prefix) => `Disallow: ${prefix}`),
    ...PUBLIC_READS.map((path) => `Allow: ${path}`),
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
