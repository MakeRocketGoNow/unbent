import { useSyncExternalStore } from 'react';
import { Workbox, messageSW } from 'workbox-window';
import { within } from './sw/routes.js';
import { pageBusy } from './busy.js';
import { buildInfo } from './build-info.js';

/**
 * Installs the service worker that keeps the app openable without a connection — see
 * `sw/sw.ts` for what it holds — and says when a newer build than this page is in charge.
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
 *
 * There used to be four hundred lines here deciding *when* a page could be moved onto a
 * new deploy: on a change of section, after five minutes away, while nothing had been
 * touched since the load, at once on dev and previews, never in a text field, at most
 * once a minute. Each rule answered an incident — a reload that drew the old build, a
 * reload that reset a list someone was three hundred rows into — and together they
 * still moved every other tab onto the new worker without reloading it, with its chunks
 * gone. Two changes in the worker made the rules unnecessary: a page load is answered
 * from the network first, so a reload is always the newest build; and the previous
 * build's shell stays cached, so a page in use keeps working after the new worker takes
 * charge. The worker is told to take charge the moment it has installed, no page is
 * ever reloaded by this file, and the one thing left to say is that a reload would bring
 * a newer build (`useUpdateNotice`), which is said only when it is so.
 */
let wb: Workbox | undefined;

/** The commit this page was built from, for telling whether the worker in charge is newer. */
const PAGE_COMMIT: string | null = buildInfo?.commit ?? null;

let noticeShown = false;
const noticeListeners = new Set<() => void>();
function setNotice(shown: boolean): void {
  if (noticeShown === shown) return;
  noticeShown = shown;
  for (const listener of noticeListeners) listener();
}

export function registerServiceWorker(): void {
  recoverFromMissingChunks();
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const worker = (wb = new Workbox('/sw.js'));
  /*
     A worker took charge of this page: this build's, found during this load, or a newer
     one. Only a newer one is worth a word. The browser's own event, not workbox-window's
     `controlling`: workbox-window counts an update found more than a minute after
     registering, or any second one, as somebody else's, keeps pointing at the worker it
     started with, and stops listening — so a deploy found on a return to the tab, which
     is the case the notice exists for, was never said.
  */
  navigator.serviceWorker.addEventListener('controllerchange', () => void sayIfNewer());
  /*
     A page already under a worker registers at once and asks for a new one straight
     away. Workbox otherwise waits for the window's `load`, so as not to compete with a
     first visit's downloads — right for a first visit, but a page the worker served from
     its cache has no such downloads, and waiting only costs it time. The browser's own
     check after a load comes a second or two later still; asking at once starts the new
     version's download that much sooner.
  */
  const updating = navigator.serviceWorker.controller !== null;
  wb.register({ immediate: updating })
    .then(() => (updating ? worker.update() : undefined))
    .catch(() => {
      // An insecure origin, a private window that refuses storage, a WebView built
      // without it: the app still works, it just cannot open offline.
    });
  checkForUpdatesOnReturn(worker);
}

/**
 * Whether the worker now in charge is a newer build than this page, which a reload would
 * bring: the worker's commit, asked of it, against the page's own. A page whose load
 * found and installed this build's own worker hears `controllerchange` too, and has nothing
 * to be told. Unknown on either side is not newer: a word that might be wrong is worse than
 * none, and the next load brings the newest build regardless.
 */
export function isNewerBuild(page: string | null, worker: string | null): boolean {
  return page !== null && worker !== null && page !== worker;
}

async function sayIfNewer(): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  const commit = await within(askBuild(controller), 5_000, null).catch(() => null);
  if (isNewerBuild(PAGE_COMMIT, commit)) setNotice(true);
}

/** The commit the worker in charge was built from, from the page it holds (`BUILD` in `sw.ts`). */
function askBuild(controller: ServiceWorker): Promise<string | null> {
  return messageSW(controller, { type: 'BUILD' }).then((answer: unknown) => (answer as { commit?: string | null } | null)?.commit ?? null);
}

export type OfflineReady = 'ready' | 'installing' | 'unavailable';

/**
 * Whether the app itself can open with no connection yet, for Settings → Offline.
 *
 * The worker downloads the shell in the background after the first visit, and a person
 * who goes offline before it has finished gets no app at all, with nothing on screen to
 * have told them. "Ready" is this page being under a worker (`controller`): the worker
 * claims its clients when it activates, which is after the precache is whole, so the
 * moment the page is controlled is the moment the shell is on the device. Waiting on
 * `serviceWorker.ready` alone would say so too early for a page opened before the worker
 * existed, which is only controlled once `controllerchange` fires.
 *
 * `prod` is a parameter because a development build never registers a worker, and
 * "installing" there would be a promise nothing keeps.
 */
export function offlineReadyState(env: {
  prod: boolean;
  serviceWorker: Pick<ServiceWorkerContainer, 'controller'> | undefined;
}): OfflineReady {
  if (env.serviceWorker?.controller) return 'ready';
  if (!env.prod || !env.serviceWorker) return 'unavailable';
  return 'installing';
}

const currentOfflineReady = (): OfflineReady =>
  offlineReadyState({
    prod: import.meta.env.PROD,
    serviceWorker: typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
  });

export function useOfflineReady(): OfflineReady {
  return useSyncExternalStore((listener) => {
    const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
    if (!container) return () => {};
    container.addEventListener('controllerchange', listener);
    // `ready` resolves when a worker is active, which can precede the claim; ask again
    // then in case the claim came first and its event was missed.
    let live = true;
    void container.ready.then(() => live && listener()).catch(() => {});
    return () => {
      live = false;
      container.removeEventListener('controllerchange', listener);
    };
  }, currentOfflineReady, () => 'unavailable');
}

/**
 * Whether to say that a reload would bring a newer build, for `UpdateSnackbar`, and the
 * two answers to it.
 *
 * Said once a newer build's worker is in charge of this page, which is the moment this
 * page stopped being the newest; said once, and left to the person: this file never
 * reloads a page in use. Dismissing it changes nothing but the notice — the next load,
 * whenever it comes, is the newest build.
 */
export function useUpdateNotice(): { shown: boolean; reload: () => void; dismiss: () => void } {
  const shown = useSyncExternalStore(
    (listener) => {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    () => noticeShown,
  );
  return { shown, reload: reloadIntoUpdate, dismiss: () => setNotice(false) };
}

/**
 * The notice's Reload. If the page is holding work a reload would lose — a save not yet
 * sent, an upload, an import — it waits for that to finish rather than refusing, since a
 * press of Reload is a decision already made; the note's own status says when its save
 * is done.
 */
function reloadIntoUpdate(): void {
  setNotice(false);
  const go = () => {
    if (pageBusy()) {
      setTimeout(go, 250);
      return;
    }
    location.reload();
  };
  go();
}

/**
 * Coming back into view, ask for a new worker — at most once a minute.
 *
 * The browser checks on its own only when a page of the site is loaded — never, for an
 * app that is resumed rather than reopened, and an installed app is almost never closed.
 * Coming back to the tab is exactly when someone expects to find a deploy, and a check is
 * one small request for `sw.js`, answered unchanged almost every time; the minute only
 * keeps a run of quick switches from making one each. What a found deploy does is the
 * same as at any other time: its worker installs, takes charge, and the notice says so.
 */
export const UPDATE_CHECK_INTERVAL = 60 * 1000;

export function shouldCheckOnReturn(sinceLastCheck: number): boolean {
  return sinceLastCheck >= UPDATE_CHECK_INTERVAL;
}

function checkForUpdatesOnReturn(worker: Workbox): void {
  let last = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!shouldCheckOnReturn(Date.now() - last)) return;
    last = Date.now();
    void worker.update().catch(() => {});
  });
}

/**
 * Reloads once when a route's code cannot be loaded because a deploy has removed it.
 *
 * Every build names its chunks by content, and a deploy replaces the whole set. The
 * worker keeps the previous build's chunks for a page still running it, but only the
 * previous build's: a page that outlives two deploys without a reload, or one from
 * before there was a worker, asks for a chunk that no longer exists, and the worker
 * answers the asset layer's `index.html` with the 404 it is. Vite raises
 * `vite:preloadError` for exactly this; a reload fetches the current build.
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
