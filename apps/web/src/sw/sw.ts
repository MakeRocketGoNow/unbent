import { PrecacheController, PrecacheRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, type StrategyOptions } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { API_CACHE, FILES_CACHE, FILES_CHANGED, MAX_KEPT_FILE, SERVED_HEADER, SHELL_CACHE_PREFIX, VIEW_HEADER, classify, isAsset, isShellFallback, servesShell, shellCacheName, shelved, within } from './routes.js';
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
 *
 * What it does, in order of what matters:
 *
 * - A page load is answered from the network first, and from the cached shell only when
 *   the network does not answer. So a reload is always the newest build, and the whole
 *   question of *when* to move a page onto a new deploy — a change of section, five
 *   minutes away, nothing touched yet — goes away with the rules that answered it.
 * - Each build's shell is kept in a cache of its own, and the previous build's cache is
 *   kept until the one after it. A tab still running the previous build asks for its
 *   chunks under their old names, and finds them: a new worker taking charge no longer
 *   pulls the code out from under every other tab (see the assets route).
 * - What the shell is filled with is checked: a chunk that no longer exists is answered
 *   by the Worker with `index.html` and a 200, and a fill that took that for a chunk
 *   stored HTML under a script's name.
 */
declare const self: ServiceWorkerGlobalScope;

/**
 * The shell: `index.html`, every script and stylesheet the build emitted, the icons, and
 * pdf.js with its WebAssembly decoders, so a PDF someone opened can still be drawn. The
 * list and what it leaves out is in `vite.config.ts`.
 *
 * In a cache named for this build — the revision of its `index.html`, which carries the
 * commit and so changes with every deploy — rather than Workbox's one cache for every
 * build. With one cache, activating a new worker deleted every chunk the previous build
 * had and the current one does not, in every tab at once, and only the tab that asked
 * for the hand-off was reloaded; the rest ran on with their next route's chunk gone,
 * answered by the Worker with `index.html`, and showed the router's error screen inside
 * a drawn shell. Now the previous build's cache outlives its worker (`tidyShellCaches`),
 * and those tabs keep working until they reload.
 *
 * A controller of our own rather than `precacheAndRoute`, only so the install below can
 * be ours; the route and the activate step are Workbox's, unchanged.
 */
const manifest = self.__WB_MANIFEST;
const BUILD = manifest.find((entry) => (typeof entry === 'string' ? entry : entry.url).replace(/^\.?\//, '') === 'index.html');
const SHELL_CACHE = shellCacheName(typeof BUILD === 'object' ? (BUILD.revision ?? 'unversioned') : 'unversioned');
const shell = new PrecacheController({ cacheName: SHELL_CACHE });
shell.addToCacheList(manifest);
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
 * Every answer is checked for being the page in disguise (`isShellFallback`): the asset
 * layer answers a path it does not have with `index.html` and a 200, so a fill that
 * straddled a deploy, or a refill by a worker older than the live deploy, stored HTML
 * under a chunk's name and then served it to a `<script>`. Online that was a reload;
 * offline it was a blank page. Such an answer fails the fill, and the fill is tried
 * again on the next install or page load.
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
    if (isShellFallback(new URL(url), response.headers.get('Content-Type'))) throw new Error(`${url}: answered with the page, not the file`);
    await cache.put(cacheKey, response.redirected ? unredirected(response) : response);
  };
  const entries = [...shell.getURLsToCacheKeys()];
  const isPage = ([url]: [string, string]) => new URL(url).pathname === '/index.html';
  const queue = entries.filter((entry) => !isPage(entry));
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
  // Last, so a cached page means a whole shell: the navigation route refills on its
  // absence and on nothing else. Stored in manifest order it could land early, and a
  // refill that then stopped — the worker killed, a chunk gone from a newer deploy —
  // was never taken up again; the app worked online and had no shell offline until the
  // next deploy (review of #331).
  for (const entry of entries.filter(isPage)) await store(entry);
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
    .catch((error: unknown) => console.warn('[sw] refilling the shell failed', error))
    .finally(() => {
      refilling = null;
    });
  return refilling;
}

/**
 * The shell caches that are neither this build's nor the one before it, once this worker
 * is in charge — and the one cache Workbox used to keep every build in, from before each
 * build had its own.
 *
 * The previous build is kept on purpose: a tab still running it keeps finding its chunks
 * (the assets route) until it reloads. A tab that outlives two deploys without a reload
 * loses them, and gets the reload `recoverFromMissingChunks` does for a chunk that is
 * gone. Which build was previous is remembered in a cache of its own, since cache names
 * carry no order.
 */
const SHELL_META = `${SHELL_CACHE_PREFIX}meta`;
const PREVIOUS_KEY = '/previous';

async function tidyShellCaches(): Promise<void> {
  const meta = await caches.open(SHELL_META);
  const before = await meta.match(PREVIOUS_KEY).then((r) => r?.text()).catch(() => undefined);
  const previous = before && before !== SHELL_CACHE ? before : undefined;
  for (const name of await caches.keys()) {
    const ours = name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_META;
    const workbox = name.includes('-precache-');
    if ((ours && name !== SHELL_CACHE && name !== previous) || workbox) await caches.delete(name);
  }
  await meta.put(PREVIOUS_KEY, new Response(SHELL_CACHE));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(tidyShellCaches());
});

/**
 * Take charge of the pages already open the moment this worker is active, rather than
 * waiting for their next load.
 *
 * Without this the page that registers the worker is never under it: the first session
 * after installing the app — sign in, open a note, walk into a tunnel — kept nothing,
 * because none of its reads passed through the worker. On the phone that first session
 * is the one a reviewer tries. Safe for an update, because the previous build's shell
 * stays cached: a page still running it goes on finding its chunks under this worker.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * How long a page load waits for the network before the cached shell answers instead.
 * The page is two kilobytes; a connection that has not answered in this long is one
 * that carries nothing, and the shell is the right answer on it. A device with no
 * network at all fails the fetch at once and never waits this long.
 */
const NAVIGATION_TIMEOUT_MS = 3000;

/**
 * Every page load of the app: from the network first, so a reload is the newest build,
 * and from the cached `index.html` when the network does not answer in time, which is
 * what lets the installed app open on a plane. The router takes it from there either way.
 *
 * It used to be the other way round — the cached shell always, online too — which is
 * what an app shell classically is, and what made a deploy unreachable: a reload drew the
 * build the worker held, and a set of rules grew around when the page could be moved
 * onto the new one (a change of section, five minutes away, nothing touched since the
 * load), each one the answer to a reload that showed the old build or a reload that
 * lost someone's place. Network first costs one round trip on a cold load online and
 * answers all of them: the newest build is whatever the next load draws, and a page in
 * use is never moved.
 *
 * Registered before the precache route, which would otherwise answer `/` itself from the
 * cache, as `index.html`, and never come here. `/index.html` is not a route of the app
 * (`servesShell`) and stays the precache route's: on a miss it fetches that address,
 * whose redirect to `/` a page load cannot be given (the fetch spec's rule for
 * `redirect: 'manual'`), but nothing loads that address on purpose.
 *
 * A miss on the cache under a live worker is a real state: Chrome's "Clear cached images
 * and files" removes the worker's caches and leaves the worker registered, and so does a
 * device short of storage. Every page load looks, whether the network answered it or
 * not, and the shell is fetched again in the background when it is missing: looked for
 * only on the loads the network failed, an emptied cache stayed empty for as long as the
 * network kept answering, which is until the one load that needed it (the first run of
 * the offline gate against this route). `index.html` is the one file looked for because
 * `fillShell` stores it last, once every other file is in: its presence means the whole
 * shell is, and its absence means a fill is owed (seen on 2026-10-09).
 */
registerRoute(
  ({ request, url }) => request.mode === 'navigate' && servesShell(url),
  async ({ event, request }) => {
    const cached = shell.matchPrecache('/index.html');
    const fresh = await within(
      fetch(request).then((response) => (response.ok ? response : null)),
      NAVIGATION_TIMEOUT_MS,
      null,
    );
    if (fresh) {
      event.waitUntil(cached.then((hit) => (hit ? undefined : refillShell())));
      return fresh;
    }
    const hit = await cached;
    if (hit) return hit;
    event.waitUntil(refillShell());
    return fetch(request);
  },
);

registerRoute(new PrecacheRoute(shell));

/**
 * A hashed asset this build's shell does not hold: the previous build's, asked for by a
 * tab still running it. Answered from whichever shell cache has it, and otherwise from
 * the network — unless the network answers with the page, which is the asset layer
 * saying the file is gone: that is turned into the 404 it is, so the import fails as a
 * missing module and the page reloads itself (`recoverFromMissingChunks`), rather than
 * failing as HTML where a script was expected, which it does too, but later and less
 * clearly. The precache route, registered before this, answers this build's own assets.
 */
registerRoute(
  ({ request, url }) => isAsset(url, self.location.origin) && request.mode !== 'navigate',
  async ({ request, url }) => {
    const kept = await caches.match(request, { ignoreSearch: true });
    if (kept) return kept;
    const response = await fetch(request);
    if (response.ok && isShellFallback(url, response.headers.get('Content-Type'))) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    return response;
  },
);

const DAY = 24 * 60 * 60;

/** A Workbox plugin, named through the strategies' options rather than `workbox-core`, which is not a dependency of its own here. */
type Plugin = NonNullable<StrategyOptions['plugins']>[number];

/**
 * Marks a read answered from a cache (`SERVED_HEADER`), so the page can tell it from an
 * answer the server gave. On the network-first config read that is how the page learns
 * the network failed without asking again: that strategy reads its cache only when the
 * network has failed or timed out. On the cache-first file reads it is the opposite
 * guard: an answer with no mark is taken by `request` in `notes-api.ts` as the server
 * being reachable, and a picture drawn from the cache on a plane must not say so. The
 * body is passed through as it is; only the headers are copied.
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
const openedFiles = new CacheFirst({ cacheName: FILES_CACHE, plugins: [keepableFile, budgeted, emptiedWhenFull, servedFromCache] });

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
 * Messages from the page.
 *
 * `SKIP_WAITING`: a new deploy's worker has installed; the page tells it to take charge
 * as soon as it hears (`sw-register.ts`). Safe at any moment, since the previous build's
 * shell stays cached for the pages still running it.
 *
 * `BUILD`: which deploy this worker is. Answered on the port the page sent, with the
 * commit read out of the precached page — the one place the worker can learn it without
 * the build plumbing it through — so a page can tell whether the worker now in charge
 * is a newer build than itself, and say that a reload would bring it (`UpdateSnackbar`).
 *
 * `FILES_CHANGED`: the page put a file in the files cache itself.
 */
self.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  if (type === 'BUILD') event.waitUntil(answerBuild(event.ports[0]));
  if (type === FILES_CHANGED) event.waitUntil(ledger.sweep());
});

async function answerBuild(port: MessagePort | undefined): Promise<void> {
  if (!port) return;
  const page = await shell.matchPrecache('/index.html').catch(() => undefined);
  const html = (await page?.text().catch(() => '')) ?? '';
  const commit = /<meta name="unbent-commit" content="([^"]+)"/.exec(html)?.[1] ?? null;
  port.postMessage({ type: 'BUILD', commit });
}
