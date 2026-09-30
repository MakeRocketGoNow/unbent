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

/**
 * The two runtime caches, named here because the page empties them too — on sign-out, on
 * a session the server refuses, and when a different account signs in on this device
 * (`offline-cache.ts`). The version is in the name so a later change of shape can drop a
 * cache outright; the local store MAK-140 builds replaces `api-v1` that way.
 */
export const API_CACHE = 'api-v1';
export const FILES_CACHE = 'files-v1';

/**
 * The header the page puts on a fetch of a file's bytes that someone is looking at —
 * today only the PDF viewer's (`loadPdf`). An image needs none: the browser marks an
 * `<img>` load itself, as `destination: 'image'`.
 */
export const VIEW_HEADER = 'X-Unbent-View';

/**
 * The header the worker adds to a read it answered from its cache because the network
 * failed — how the page learns it is offline from the very request that needed the network
 * (`request` in `notes-api.ts`), rather than from a second request asking.
 */
export const SERVED_HEADER = 'X-Unbent-Served';

/**
 * The reads the note list and an open note are drawn from, which the worker keeps the
 * last copy of: the list pages and their counts, a note, its files' metadata, the tags,
 * the notebooks and a notebook's fields, and the instance's config. Nothing else — search,
 * export, admin, a file's extracted text, the auth endpoints — has any use offline, and
 * every write goes straight through.
 *
 * Matched by the whole shape of the path, never by prefix, because GETs that must not be
 * cached live under these same prefixes: `/api/notes/<id>/export` is a download,
 * `/api/notebooks/<id>/fields/<field>/conversion` is a question about a change about to
 * be made. One path segment per `[^/]+`; an id or a file name is always one segment,
 * encoded.
 */
const CACHED_READS = [
  /^\/api\/notes$/,
  /^\/api\/notes\/[^/]+$/,
  /^\/api\/notes\/[^/]+\/files$/,
  /^\/api\/tags$/,
  /^\/api\/notebooks$/,
  /^\/api\/notebooks\/[^/]+\/fields$/,
  /^\/api\/config$/,
];

/** A file's bytes: `/api/notes/<id>/files/<name>`, and not its `/text`. */
const FILE_BYTES = /^\/api\/notes\/[^/]+\/files\/[^/]+$/;

export interface RequestFacts {
  url: URL;
  method: string;
  /** `Request.destination`: `'image'` for an `<img>`, empty for a `fetch`. */
  destination: string;
  /** Whether the page marked the request as someone looking at the file (`VIEW_HEADER`). */
  viewed: boolean;
  /** The worker's own origin. */
  origin: string;
}

/**
 * Which runtime cache, if any, answers a request.
 *
 * `api`: the reads above, from the network first and from the cache only when the network
 * fails. `file`: a file's bytes when someone is looking at them, from the cache first —
 * they are served `immutable`, so a copy never goes stale.
 *
 * "Looking at" is the rule that matters for files. The indexer reads every PDF in the
 * archive to extract its text, and an export reads every file; both fetch the same
 * addresses the viewer does, and caching those would fill the budget with the archive and
 * push out what the person actually opened. They carry no mark and pass straight through.
 * A download (`?download=1`) is a save, not a view, and passes through too; so does an
 * image from another site, which the rich editor also draws as an `<img>` but whose size
 * an opaque response hides.
 */
export function classify(request: RequestFacts): 'api' | 'file' | undefined {
  const { url } = request;
  if (request.method !== 'GET' || url.origin !== request.origin) return undefined;
  if (CACHED_READS.some((shape) => shape.test(url.pathname))) return 'api';
  if (
    FILE_BYTES.test(url.pathname) &&
    !url.searchParams.has('download') &&
    (request.destination === 'image' || request.viewed)
  ) {
    return 'file';
  }
  return undefined;
}
