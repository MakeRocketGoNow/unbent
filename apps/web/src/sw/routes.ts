/**
 * Which requests the service worker answers, and how — as plain functions over a URL so
 * they can be tested without a worker.
 *
 * The worker itself (`sw.ts`) is a handful of Workbox registrations that ask these. Kept
 * apart because a worker module registers its routes the moment it loads, which makes it
 * impossible to import into a test, and because these rules are the part that decides what
 * a person can read on a plane: they deserve a table of cases more than the plumbing does.
 */

/**
 * The paths the Worker answers itself, which a page load must never be given the app
 * shell for.
 *
 * The same three prefixes `wrangler.toml` lists under `run_worker_first`, for the same
 * reason: each is a real server response rather than a route of the SPA. A shell for
 * `/api/auth/callback/google` would swallow a sign-in, and one for
 * `/api/notes/…/files/…?download=1` would open the app where a download was asked for.
 */
const WORKER_PREFIXES = ['/api/', '/.well-known/', '/ingest/'];

/**
 * Whether a page load at this address should be answered with the app itself.
 *
 * Every route of the SPA is a path with no extension — `/notes/<uuid>`, `/settings/tags`
 * — and the Worker's SPA fallback answers each with `index.html`, so the worker does the
 * same from its cache. What it must not do is answer a load of a real file that way:
 * someone opening `/manifest.webmanifest` or an icon in a tab would get the app, which is
 * the fallback's behaviour only because the file is missing, not a route. A dot in the
 * last segment is the tell; no route here has one.
 */
export function servesShell(url: URL): boolean {
  if (WORKER_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return false;
  const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  return !last.includes('.');
}
