import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { servesShell } from './routes.js';

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
