import { Workbox } from 'workbox-window';
import { pageBusy } from './busy.js';

/**
 * Installs the service worker that keeps the app openable without a connection — see
 * `sw/sw.ts` for what it holds — and moves the page onto a new deploy when one arrives.
 *
 * Only in a production build. Vite's development server serves source modules under
 * names that change with every edit, and a worker caching those would serve yesterday's
 * code; the worker is tried against the built app the Worker serves instead.
 *
 * Through `workbox-window` rather than `vite-plugin-pwa`'s virtual module, so that the
 * plugin's only job is writing the file list into the worker and it can be replaced
 * without touching this.
 *
 * Nothing waits on registering. It fetches `/sw.js` and precaches the shell in the
 * background; a browser without service workers, or a registration that fails, leaves
 * the app exactly as it was before there was one.
 */
let wb: Workbox | undefined;

/** A new deploy's worker has installed and is waiting to take over. */
let updateReady = false;

/** Where the page currently is, for telling a change of page from a change of filter. */
let currentPath: () => string = () => location.pathname;

export function registerServiceWorker(pathNow: () => string): void {
  recoverFromMissingChunks();
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  currentPath = pathNow;
  wb = new Workbox('/sw.js');
  // Fires for a worker that installed during this visit and for one already waiting when
  // the page loaded, which is the Android app's usual case: it resumes rather than reloads.
  wb.addEventListener('waiting', () => {
    updateReady = true;
  });
  wb.register().catch(() => {
    // An insecure origin, a private window that refuses storage, a WebView built without
    // it: the app still works, it just cannot open offline.
  });
  checkForUpdatesOnReturn(wb);
}

/**
 * Whether a navigation should become a full load into the waiting deploy.
 *
 * A worker that controls the page serves the shell it precached, so without this a new
 * deploy reaches nobody until every window of the app is closed — and an installed app,
 * the Android one above all, is almost never closed; it is sent to the background and
 * resumed. So the next time someone goes to another page, the app loads that page from
 * the new deploy instead of drawing it in the old one. No prompt: a reload on the way to
 * a page that was about to be drawn anyway is not something to ask about.
 *
 * Only on a change of section — notes to settings, settings to trash — the first segment
 * of the path. Within one it would read as the app breaking: opening a note from the list
 * is the most common navigation there is, and reloading the split view then lost the
 * list's place and every page loaded past the first, with the note just clicked suddenly
 * off screen. A filter or a sort is a navigation too, for the same reason. Never for a
 * preload, which is a hover rather than a decision; never inside the Android app's embed
 * pages, whose lifecycle the app owns; and never while the page is holding work a reload
 * would lose (`busy.ts`) — the next navigation gets another chance. Coming back to the
 * app after it was out of view is the other moment (`checkForUpdatesOnReturn`).
 */
export function shouldApplyUpdate(state: {
  ready: boolean;
  busy: boolean;
  preload: boolean;
  from: string;
  to: string;
}): boolean {
  if (!state.ready || state.busy || state.preload) return false;
  if (state.to.startsWith('/embed/') || state.from.startsWith('/embed/')) return false;
  return section(state.from) !== section(state.to);
}

const section = (path: string) => path.split('/')[1] ?? '';

/**
 * Called from the root route's `beforeLoad` with the destination. When the update should
 * apply, tells the waiting worker to take over and loads the destination fresh once it
 * has; the returned promise never settles, which holds the router on the current page
 * rather than drawing the destination in the old build a moment before the page goes.
 *
 * The timer is the way out if `controlling` never arrives — a worker that failed to
 * activate, say. A plain load of the destination is still the right outcome then: it
 * gets whichever worker is in charge.
 */
export function takeUpdate(to: { pathname: string; href: string }, preload: boolean): Promise<never> | undefined {
  const apply = shouldApplyUpdate({
    ready: updateReady,
    busy: pageBusy(),
    preload,
    from: currentPath(),
    to: to.pathname,
  });
  if (!apply || !wb) return undefined;
  updateReady = false;
  return new Promise<never>(() => handOver(wb!, to.href));
}

/** Lets the waiting worker take over, then loads `href` from it. */
function handOver(worker: Workbox, href: string): void {
  // Once: `controlling` and the timer can both fire, and a second `assign` on a slow
  // load would restart the navigation already under way.
  let gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    location.assign(href);
  };
  worker.addEventListener('controlling', go);
  worker.messageSkipWaiting();
  setTimeout(go, 3000);
}

/**
 * Coming back into view: take a deploy that is already waiting, and otherwise ask for one.
 *
 * The return is the quietest moment there is — nothing on screen is mid-use — so a waiting
 * deploy is taken then, in place, when the page holds nothing a reload would lose and is
 * not one of the Android app's embed pages. It is how an app someone keeps open in one
 * section, the notes list most of all, still reaches a new deploy.
 *
 * Asking for a new worker happens at most every half hour.
 *
 * The browser checks on its own only when a page of the site is loaded from the network —
 * never, for an app that is resumed rather than reopened. Half an hour because a deploy
 * is not urgent, and every check is a request for `sw.js`.
 */
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

function checkForUpdatesOnReturn(worker: Workbox): void {
  let last = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (updateReady && !pageBusy() && !location.pathname.startsWith('/embed/')) {
      updateReady = false;
      handOver(worker, location.href);
      return;
    }
    if (Date.now() - last < UPDATE_CHECK_INTERVAL) return;
    last = Date.now();
    void worker.update().catch(() => {});
  });
}

/**
 * Reloads once when a route's code cannot be loaded because a deploy has removed it.
 *
 * Every build names its chunks by content, and a deploy replaces the whole set. A page
 * still running the previous build that then opens a route it had not loaded yet asks for
 * a chunk that no longer exists, and the SPA fallback answers with `index.html` — which
 * surfaces as the route's error screen. Vite raises `vite:preloadError` for exactly this;
 * a reload fetches the current build. The worker's precache keeps the previous build's
 * chunks for as long as it is in charge, so this is mostly the path for a page from before
 * there was a worker, or one whose update took over from another window.
 *
 * At most once a minute, so a chunk that is genuinely broken shows its error instead of
 * reloading forever; the error then reaches the route's boundary as it always did.
 */
const RELOADED_AT = 'unbent.chunk-reload';

function recoverFromMissingChunks(): void {
  window.addEventListener('vite:preloadError', (event) => {
    try {
      const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem(RELOADED_AT, String(Date.now()));
    } catch {
      // Storage refused: reloading without the guard could loop, so leave the error be.
      return;
    }
    event.preventDefault();
    location.reload();
  });
}
