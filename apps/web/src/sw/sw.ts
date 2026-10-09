import { PrecacheController, PrecacheRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, type StrategyOptions } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { API_CACHE, FILES_CACHE, FILES_CHANGED, MAX_KEPT_FILE, SERVED_HEADER, VIEW_HEADER, classify, servesShell, shelved, within } from './routes.js';
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
 *
 * A controller of our own rather than `precacheAndRoute`, only so the install below can
 * be ours; the route and the activate step are Workbox's, unchanged.
 */
const shell = new PrecacheController();
shell.addToCacheList(self.__WB_MANIFEST);
registerRoute(new PrecacheRoute(shell));
self.addEventListener('activate', shell.activate);

/**
 * Downloads the files of the shell the cache does not hold, a few at a time, and stores
 * each under its key.
 *
 * Workbox's own install fetches them strictly one after another (its issue 2528: a first
 * install is over two hundred files, and firing them all at once is what that guards
 * against). But a new deploy's worker does not reach `waiting` until every file is in,
 * and the page cannot be moved onto it before then — so the whole queue is the time
 * between a reload and the new version. Vite's hashes cascade, so a one-line change
 * re-fetches forty-odd chunks: with 150 ms added to every request, about what unbent.app
 * answers in, that queue took seven seconds one at a time and under two and a half six at
 * a time — and longer on a phone, or behind the app's own startup traffic. Six is still
 * only a handful in flight.
 *
 * The same work as Workbox's install otherwise: a file already cached under its key costs
 * nothing, and a revisioned file — one whose name has no hash, `index.html` above all —
 * is fetched past the HTTP cache, which is what Workbox's `reload` mode is for. Its key
 * carries `__WB_REVISION__` where a hashed file's key is its address, which is how that is
 * told without its private map. A redirected response is stored as a plain copy, as
 * Workbox stores it: the Worker answers `/index.html` with a redirect to `/`, and a
 * response that remembers being redirected cannot be given to a page load (see below).
 *
 * Ours rather than `PrecacheStrategy`'s because it runs twice over: from the install
 * event, and again from a page load that found the cache empty (`refillShell`). Workbox
 * stores what it fetches outside the install only when the manifest carries integrity
 * hashes, which this one does not, so with the strategy an emptied cache was never
 * filled again until the next deploy. A fetch that fails ends the fill, once every loop
 * has stopped: in the install that fails the install, and the browser tries again on
 * the next load; in a refill it is caught, and the next page load tries again.
 */
const INSTALL_CONCURRENCY = 6;

async function fillShell(): Promise<void> {
  const cache = await caches.open(shell.strategy.cacheName);
  const store = async ([url, cacheKey]: [string, string]): Promise<void> => {
    if (await cache.match(cacheKey)) return;
    const response = await fetch(
      new Request(url, {
        integrity: shell.getIntegrityForCacheKey(cacheKey),
        cache: cacheKey === url ? 'default' : 'reload',
        credentials: 'same-origin',
      }),
    );
    if (response.status !== 200) throw new Error(`${url}: ${response.status}`);
    await cache.put(cacheKey, response.redirected ? unredirected(response) : response);
  };
  const queue = [...shell.getURLsToCacheKeys()];
  // The first failure stops every loop at its next file, and the fill settles only once
  // all of them have: `Promise.all` alone rejects at once and leaves the other loops
  // fetching, which let a second refill start beside the first (review of #331).
  let failure: unknown;
  const next = async (): Promise<void> => {
    for (let entry = queue.shift(); entry && !failure; entry = queue.shift()) {
      await store(entry).catch((error: unknown) => {
        failure ??= error;
      });
    }
  };
  await Promise.all(Array.from({ length: INSTALL_CONCURRENCY }, next));
  if (failure) throw failure;
}

/** The same body and headers, without the mark of having been redirected. */
function unredirected(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(fillShell());
});

/**
 * One refill at a time: every page load that finds the cache empty asks for one, and a
 * burst of tabs opened together must not start six fetches each.
 */
let refilling: Promise<void> | null = null;
function refillShell(): Promise<void> {
  refilling ??= fillShell()
    .catch(() => {})
    .finally(() => {
      refilling = null;
    });
  return refilling;
}

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
 * When the cache does not hold it, the load goes to the network as itself — the request
 * the browser made, which the Worker answers with `index.html` directly — and the shell
 * is fetched again in the background. The cache can be empty under a live worker:
 * Chrome's "Clear cached images and files" removes the worker's caches and leaves the
 * worker registered, and so does a device short of storage. Workbox's handler bound to
 * `/index.html` fetched that address on a miss and handed the page load what came back
 * — the Worker's redirect to `/`, followed — and a response that was redirected is a
 * network error for a navigation (the fetch spec's rule for `redirect: 'manual'`). Every
 * page load then failed with "This site can't be reached", on every tab, until the next
 * deploy installed a worker with a full cache, since the strategy repairs nothing without
 * integrity hashes. Seen on 2026-10-09, after clearing the cache to get a fresh load.
 */
registerRoute(
  ({ request, url }) => request.mode === 'navigate' && servesShell(url),
  async ({ event, request }) => {
    const cached = await shell.matchPrecache('/index.html');
    if (cached) return cached;
    event.waitUntil(refillShell());
    return fetch(request);
  },
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
 * What empties this cache when the browser refuses a write for want of room.
 *
 * The budget above keeps the cache under 500 MB; it cannot know the device has less than
 * that to give. When a store fails with a quota error, Workbox runs the callbacks its
 * plugins registered, and this plugin's is "delete this cache" — the cheapest storage the
 * app holds, refilled by opening things. Without it the cache went on failing to store
 * while sitting on whatever it had (review of #236).
 *
 * The expiration plugin is here for that alone: `purgeOnQuotaError` is the only way to
 * that callback without `workbox-core` as a dependency of our own. It must be given an
 * age or a count to be constructed, and it is given a count it will never reach — not an
 * age. With an age the plugin also refuses a cached response whose `Date` header is older
 * than it, and that header is when the file was fetched, not when it was last opened: a
 * manual read every week would have gone missing a month after its first download, which
 * is the one thing the budget's oldest-opened rule exists to prevent (review of #236).
 * What is kept and for how long is the ledger's alone. The plugin's own record of
 * addresses outlives what the ledger evicts; it is a few bytes each and is dropped with
 * the cache on a purge.
 */
const emptiedWhenFull = new ExpirationPlugin({ maxEntries: Number.MAX_SAFE_INTEGER, purgeOnQuotaError: true });

/**
 * The bytes of a file someone looked at — an image drawn in a note, a PDF opened in the
 * viewer — so the same note reads the same with no connection.
 *
 * Cache first, because these never change: the Worker serves them `immutable`, keyed by
 * the attachment. Only what was looked at, never what the indexer or an export read in
 * bulk — see `classify` for why that distinction is the whole rule.
 */
const openedFiles = new CacheFirst({ cacheName: FILES_CACHE, plugins: [keepableFile, budgeted, emptiedWhenFull] });

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
/** How long the device lookup may take before the request goes on without it (see `within`). */
const LOOKUP_MS = 1500;

registerRoute(
  ({ request, url }) => shelved({ url, method: request.method, mode: request.mode, origin: self.location.origin }) !== null,
  async (options) => {
    const { request, url } = options;
    const address = shelved({ url, method: request.method, mode: request.mode, origin: self.location.origin });
    const file = address && (await within(findFile(address.noteId, address.filename), LOOKUP_MS, null));
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
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  // The page put a file in the files cache itself; see `FILES_CHANGED`.
  if (type === FILES_CHANGED) event.waitUntil(ledger.sweep());
});
