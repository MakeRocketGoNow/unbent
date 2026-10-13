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
 * The same prefixes `wrangler.toml` lists under `run_worker_first`, for the same reason:
 * each is a real server response rather than a route of the SPA. A shell for
 * `/api/auth/callback/google` would swallow a sign-in, and one for
 * `/api/notes/…/files/…?download=1` would open the app where a download was asked for.
 * The last is a whole path rather than a prefix — the manifest, which the Worker renames
 * per instance (`apps/api/src/lib/manifest.ts`) — and a path is its own prefix.
 *
 * `routes.test.ts` reads `wrangler.toml` and holds the two lists together: a prefix added
 * there and not here would have every device with the worker answer its page loads with
 * the app, and only another deploy could take that back.
 */
export const WORKER_PREFIXES = ['/api/', '/.well-known/', '/ingest/', '/manifest.webmanifest'];

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
 * cache outright. `api-v1` once held the note reads the views were drawn from; the local
 * copy of the library (`src/store/`) answers those now, and what is left in it is the
 * instance's config.
 */
export const API_CACHE = 'api-v1';
export const FILES_CACHE = 'files-v1';

/**
 * Twenty megabytes: the largest file the cache of opened files keeps. A file over it is
 * still shown online and simply not kept: a scanned archive has the odd enormous PDF, and
 * a phone's storage is better spent on the many ordinary files someone opened than on one
 * of those. A notebook kept whole (`store/keep.ts`) has no such cap; that is a choice,
 * with its size stated first.
 *
 * Here rather than in the worker because the page holds to it too: a file added offline
 * goes into this cache once it has uploaded (`remember` in `store/actions.ts`), and a
 * 90 MB one put there whole would push out hundreds of the files the cap exists for.
 */
export const MAX_KEPT_FILE = 20 * 1024 * 1024;

/**
 * What the page says to the worker when it has put a file into the cache of opened files
 * itself (`remember` in `store/actions.ts`): the worker's index learns of a file only when
 * the worker stores one or starts, so until then Settings counted one file too few, and
 * the budget did not count it at all. The worker answers by bringing the index in line
 * (`sweep` in `budget.ts`). A message type, beside `SKIP_WAITING`.
 */
export const FILES_CHANGED = 'FILES_CHANGED';

/**
 * The header the page puts on a fetch of a file's bytes that someone is looking at —
 * today only the PDF viewer's (`loadPdf`). An image needs none: the browser marks an
 * `<img>` load itself, as `destination: 'image'`.
 */
export const VIEW_HEADER = 'X-Unbent-View';

/**
 * The header the worker adds to a read it answered itself: `cache` for one from its
 * caches, `device` for one from the account's shelves. Its absence on an answer is what
 * `request` in `notes-api.ts` takes as the server having answered, which is what puts
 * the app online; `cache` on the network-first config read is how the page learns the
 * network failed from the very request that needed it, rather than from a second request
 * asking. Every answer the worker makes without the network must carry it.
 */
export const SERVED_HEADER = 'X-Unbent-Served';

/**
 * The reads the worker keeps the last copy of: the instance's config, which the sign-in
 * screen and the shell read before anything else, and nothing else. The notes, the tags,
 * the notebooks and a note's files are read from the local copy of the library
 * (`src/store/`), which the change feed keeps current; a worker copy of those reads would
 * only ever be older than the library, and the feed itself (`/api/changes`) must never be
 * answered from a cache, since a cached page replayed over a cursor is rows applied twice
 * or never. Search, export, admin, a file's extracted text and the auth endpoints have
 * no use offline, and every write goes straight through.
 *
 * Matched by the whole shape of the path, never by prefix.
 */
const CACHED_READS = [/^\/api\/config$/];

/** A file's bytes: `/api/notes/<id>/files/<name>`, and not its `/text`. */
const FILE_BYTES = /^\/api\/notes\/[^/]+\/files\/[^/]+$/;

/**
 * The note and the name in a file's address, or null for any other address. What the
 * worker looks up on the account's own shelves (`store/files.ts`) before it asks the
 * cache or the network.
 */
export function fileAddress(url: URL): { noteId: string; filename: string } | null {
  if (!FILE_BYTES.test(url.pathname)) return null;
  const [, , , noteId, , filename] = url.pathname.split('/');
  try {
    return { noteId: decodeURIComponent(noteId!), filename: decodeURIComponent(filename!) };
  } catch {
    return null;
  }
}

/**
 * Whether a request for a file's bytes may be answered from the account's shelves: the
 * files of a kept notebook, and a file added here that is still waiting to upload.
 *
 * Any read of the bytes by the page — a picture, the PDF viewer, the indexer, an export.
 * Unlike the cache, there is nothing to protect here: the bytes are already on the device
 * by choice, and reading them costs no budget.
 *
 * Never a page load. The server sends a file with a type it decided was safe to serve, a
 * disposition and a sandbox (`GET /notes/:id/files/:filename`), from the stored type the
 * worker has no way to read; a shelf's copy answered to a navigation would be an HTML
 * attachment opening as a page of this origin. A download link is a navigation too, and
 * goes to the network as before.
 */
export function shelved(request: Pick<RequestFacts, 'url' | 'method' | 'origin'> & { mode: string }): { noteId: string; filename: string } | null {
  if (request.method !== 'GET' || request.url.origin !== request.origin || request.mode === 'navigate') return null;
  return fileAddress(request.url);
}

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

/**
 * `promise`'s value, or `fallback` if it has not arrived in `ms` or it rejects.
 *
 * For the lookup in front of every file request: a stalled read of the device's file
 * system would otherwise hold every picture and PDF in the app, online too. A miss, a
 * stall and a failure all have to look the same to the page, which is to go on to the
 * cache and the network.
 */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
