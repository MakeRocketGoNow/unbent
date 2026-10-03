import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, type StrategyOptions } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { API_CACHE, FILES_CACHE, SERVED_HEADER, VIEW_HEADER, classify, servesShell, shelved } from './routes.js';
import { createFilesLedger } from './budget.js';
import { findFile } from '../store/files.js';

/**
 * The service worker: what lets the installed app open with no connection.
 *
 * Built by `vite-plugin-pwa` in `injectManifest` mode, which does exactly one thing for
 * it — replace `self.__WB_MANIFEST` with the list of files this build produced, each with
 * a revision. Everything else here is ours and Workbox's runtime modules, deliberately: if
 * the plugin ever falls behind a Vite major, a small Vite plugin of our own can write that
 * list and this file does not change. See `vite.config.ts`.
 *
 * Typechecked by its own program, `tsconfig.sw.json`. The app's program loads the Workers
 * types for the API client, and those declare a `ServiceWorkerGlobalScope` of their own —
 * the Workers runtime's, which has no `clients`, `registration` or `skipWaiting`.
 */
declare const self: ServiceWorkerGlobalScope;

/**
 * The shell: `index.html`, every script and stylesheet the build emitted, the icons, and
 * pdf.js with its WebAssembly decoders, so a PDF someone opened can still be drawn. The
 * list and what it leaves out is in `vite.config.ts`.
 *
 * Fetched in the background when the worker installs, and again only for files whose
 * revision changed — the hashed chunks of an unchanged route cost nothing on the next
 * deploy.
 */
precacheAndRoute(self.__WB_MANIFEST);

/**
 * The previous build's shell, once this one is in charge. Without it every deploy would
 * leave another copy of the app in the cache for good.
 */
cleanupOutdatedCaches();

/**
 * Take charge of the pages already open the moment this worker is active, rather than
 * waiting for their next load.
 *
 * Without this the page that registers the worker is never under it: the first session
 * after installing the app — sign in, open a note, walk into a tunnel — kept nothing,
 * because none of its reads passed through the worker. On the phone that first session
 * is the one a reviewer tries. It is also what makes the deploy hand-off prompt: the
 * `controlling` event `takeUpdate` waits for fires only when the new worker claims the
 * page, and without a claim it fell back to its timer every time.
 *
 * Safe for an update, because this worker activates only when the page has asked it to
 * (`SKIP_WAITING`) and is about to load its destination fresh anyway.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Every page load of the app is answered with the cached `index.html`, and the router
 * takes it from there — the same thing the Worker's SPA fallback does, without needing
 * the Worker.
 *
 * Online too, which is the point of an app shell: the page is the version this worker
 * holds, and a new deploy reaches it through the worker's own update rather than through
 * whichever load happens to hit the network first.
 *
 * `/index.html` is the key even though the Worker answers that address with a redirect to
 * `/`: Workbox's precache stores the redirected response's copy under the key it asked
 * for, so the handler finds it.
 */
registerRoute(
  ({ request, url }) => request.mode === 'navigate' && servesShell(url),
  createHandlerBoundToURL('/index.html'),
);

const DAY = 24 * 60 * 60;

/** A Workbox plugin, named through the strategies' options rather than `workbox-core`, which is not a dependency of its own here. */
type Plugin = NonNullable<StrategyOptions['plugins']>[number];

/**
 * Marks a read answered from the cache, so the page knows the network failed without
 * having to ask again (`SERVED_HEADER`). Network-first only reads its cache when the
 * network has failed or timed out, so every response this sees is one of those. The body
 * is passed through as it is; only the headers are copied.
 */
const servedFromCache: Plugin = {
  cachedResponseWillBeUsed: async ({ cachedResponse }) => {
    if (!cachedResponse) return cachedResponse;
    const headers = new Headers(cachedResponse.headers);
    headers.set(SERVED_HEADER, 'cache');
    return new Response(cachedResponse.body, {
      status: cachedResponse.status,
      statusText: cachedResponse.statusText,
      headers,
    });
  },
};

/**
 * What the note list and an open note were last drawn from, for drawing them again with
 * no connection. Which reads these are is `classify` in `routes.ts`.
 *
 * Network first, always, and the cache only when the network fails — never the other way
 * round. The page already caches in memory with React Query, and every save invalidates
 * exactly the entries it changed; a worker that answered from its own copy first would
 * hand that refetch the note as it was before the save, and an editor seeded from such a
 * copy would save over an edit made on another device. Two caches with one silently
 * winning is what `main.tsx` refuses for the router, for the same reason.
 *
 * Ten seconds for a connection that is up but carries nothing: the cached copy is
 * answered then, and the late response still updates the cache when it lands. Five
 * hundred reads for a month: a note is a few kilobytes, and an archive-sized account's
 * every body together is a couple of megabytes.
 */
registerRoute(
  ({ request, url }) =>
    classify({
      url,
      method: request.method,
      destination: request.destination,
      viewed: false,
      origin: self.location.origin,
    }) === 'api',
  new NetworkFirst({
    cacheName: API_CACHE,
    networkTimeoutSeconds: 10,
    plugins: [
      servedFromCache,
      new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true }),
    ],
  }),
);

/**
 * Twenty megabytes. A file over it is still shown online and simply not kept: a scanned
 * archive has the odd enormous PDF, and a phone's storage is better spent on the many
 * ordinary files someone opened than on one of those. A notebook kept whole
 * (`store/keep.ts`) has no such cap; that is a choice, with its size stated first.
 */
const MAX_KEPT_FILE = 20 * 1024 * 1024;

/**
 * Keeps only a complete, ordinary answer of a size worth keeping. A plugin that decides
 * this replaces Workbox's own "200 or opaque" check rather than adding to it, so the status
 * is checked here too.
 */
const keepableFile: Plugin = {
  cacheWillUpdate: async ({ response }) => {
    if (response.status !== 200) return null;
    const length = Number(response.headers.get('Content-Length') ?? 0);
    return length > MAX_KEPT_FILE ? null : response;
  },
};

/**
 * The cache's budget — bytes, count and age, oldest-opened out first — in place of
 * Workbox's expiration plugin, which counts entries and cannot order them by use. The
 * rule and the reasons are in `budget.ts`; this is where the cache tells it what happened.
 */
const ledger = createFilesLedger();
const budgeted: Plugin = {
  cacheDidUpdate: async ({ request, newResponse }) => {
    await ledger.stored(request.url, Number(newResponse.headers.get('Content-Length') ?? 0));
  },
  cachedResponseWillBeUsed: async ({ request, cachedResponse }) => {
    // Not awaited: the picture should not wait on the bookkeeping.
    if (cachedResponse) void ledger.touch(request.url);
    return cachedResponse;
  },
};
// What a month away, or the page putting a file in, left to tidy.
self.addEventListener('activate', (event) => {
  event.waitUntil(ledger.sweep());
});

/**
 * The bytes of a file someone looked at — an image drawn in a note, a PDF opened in the
 * viewer — so the same note reads the same with no connection.
 *
 * Cache first, because these never change: the Worker serves them `immutable`, keyed by
 * the attachment. Only what was looked at, never what the indexer or an export read in
 * bulk — see `classify` for why that distinction is the whole rule.
 */
const openedFiles = new CacheFirst({ cacheName: FILES_CACHE, plugins: [keepableFile, budgeted] });

/**
 * A file's bytes, from the nearest place that has them: the account's own shelves, then
 * the cache of what was opened, then the network.
 *
 * The shelves (`store/files.ts`) hold a kept notebook's files and a file added here that
 * has not uploaded yet — the second is why this comes first and for every read: a photo
 * taken with no connection has an address in the note the moment it is added, and this
 * is the only thing that can answer it. Which requests may be answered so is `shelved`.
 *
 * Answered with the headers the server would send that still mean something here: the
 * sandbox, in case anything ever does render one of these as a document, and no sniffing.
 * The type is the file system's guess from the name, which is enough for a picture and
 * irrelevant to pdf.js, which is handed bytes.
 *
 * One route rather than two in a row: Workbox gives a request to the first route that
 * matches and has no "not mine after all", and whether the shelf has the file is only
 * known by looking.
 */
registerRoute(
  ({ request, url }) => shelved({ url, method: request.method, mode: request.mode, origin: self.location.origin }) !== null,
  async (options) => {
    const { request, url } = options;
    const address = shelved({ url, method: request.method, mode: request.mode, origin: self.location.origin });
    const file = address && (await findFile(address.noteId, address.filename));
    if (file) {
      return new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'Content-Length': String(file.size),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          [SERVED_HEADER]: 'device',
        },
      });
    }
    const viewed =
      classify({
        url,
        method: request.method,
        destination: request.destination,
        viewed: request.headers.get(VIEW_HEADER) === '1',
        origin: self.location.origin,
      }) === 'file';
    return viewed ? openedFiles.handle(options) : fetch(request);
  },
);

/**
 * A new deploy's worker installs and then waits, because taking over at once would hand
 * a page still running the previous build a cache that no longer holds its chunks. The
 * page decides when: on its next change of page, when nothing it holds would be lost —
 * see `takeUpdate` in `sw-register.ts`, whose `messageSkipWaiting` sends this.
 */
self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});
