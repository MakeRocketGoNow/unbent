import { useSyncExternalStore } from 'react';
import { Workbox } from 'workbox-window';
import type { InstanceKind } from '@unbent/shared';
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

/*
   Whether to say so — see `UpdateSnackbar`. Separate from `updateReady`, which the
   automatic moments below consume: the notice is dismissed by a person, and dismissing it
   leaves the deploy waiting for those moments all the same.
*/
let noticeShown = false;
const noticeListeners = new Set<() => void>();
function setNotice(shown: boolean): void {
  if (noticeShown === shown) return;
  noticeShown = shown;
  for (const listener of noticeListeners) listener();
}

/** Where the page currently is, for telling a change of page from a change of filter. */
let currentPath: () => string = () => location.pathname;

/**
 * Nothing has been clicked, typed, scrolled or touched since the page loaded, or since it
 * came back after a real absence (`checkForUpdatesOnReturn`).
 */
let untouched = true;
let watchingTouch = false;

/**
 * Which instance this is, from its config, once that has loaded; until then the page is
 * treated as production, the careful case. See `takesDeploysAtOnce`.
 */
let instanceKind: InstanceKind | undefined;

/** The next look at a deploy waiting for the page to finish what it is doing (`deployArrived`). */
let retry: ReturnType<typeof setTimeout> | undefined;

/** When that wait began, and whether it has been said yet; see `deployArrived`. */
let held: { since: number; said: boolean } | undefined;
const LONG_HOLD = 3000;

export function registerServiceWorker(pathNow: () => string): void {
  recoverFromMissingChunks();
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  currentPath = pathNow;
  watchFirstTouch();
  const worker = (wb = new Workbox('/sw.js'));
  // Fires for a worker that installed during this visit and for one already waiting when
  // the page loaded, which is the Android app's usual case: it resumes rather than reloads.
  worker.addEventListener('waiting', () => {
    updateReady = true;
    deployArrived();
  });
  /*
     A page already under a worker registers at once and asks for a new one straight
     away. Workbox otherwise waits for the window's `load`, so as not to compete with a
     first visit's downloads — right for a first visit, but a page the worker served from
     its cache has no such downloads, and waiting only costs it time. The browser's own
     check after a load comes a second or two later still; asking at once starts the new
     version's download that much sooner on the reload someone did to get it.
  */
  const updating = navigator.serviceWorker.controller !== null;
  wb.register({ immediate: updating })
    .then(() => (updating ? worker.update() : undefined))
    .catch(() => {
      // An insecure origin, a private window that refuses storage, a WebView built
      // without it: the app still works, it just cannot open offline.
    });
  checkForUpdatesOnReturn(wb);
}

/**
 * Whether a deploy whose worker has just started waiting should be taken at once: on dev
 * and previews whenever the page can spare a reload (`takesDeploysAtOnce`), and elsewhere
 * while the page has only just loaded.
 *
 * A reload is how anyone asks for the newest version, and the worker answers every load
 * from the shell it holds — so without this, reloading after a deploy drew the old build,
 * and so did every reload after it until a change of section or a long absence. That made
 * a deploy impossible to try: the one gesture that should show it never did. The browser
 * checks for a new worker on every load, so the deploy is found during the load the
 * person asked for; taking it then costs one quick second load, before there is anything
 * on the page to lose.
 *
 * "Only just loaded" is until the first click, key, scroll or touch, not a time: someone
 * looking at a page they just reloaded loses nothing to a second load however long they
 * look, and someone who has started reading or typing gets the careful rules below
 * instead. Never inside the Android app's embed pages, and never while the page holds
 * work a reload would lose.
 */
export function shouldApplyOnArrival(state: {
  untouched: boolean;
  busy: boolean;
  path: string;
  kind?: InstanceKind;
}): boolean {
  if (state.busy || state.path.startsWith('/embed/')) return false;
  return state.untouched || takesDeploysAtOnce(state.kind);
}

/**
 * Whether this instance takes a new deploy the moment its worker is waiting, rather than
 * at the careful moments production waits for.
 *
 * Dev and previews exist to be tried right after a push, and the careful rules made that
 * nearly impossible on a phone: the reload drew the build the worker held, the new one
 * arrived while the tester was already scrolling, and the notice then waited for a change
 * of section or five minutes away. So they reloaded again and saw the same build, and
 * reached for clearing the site's data, which takes the worker away mid-session and makes
 * the next load slower still. On these the deploy is the thing being looked at; a reload
 * that resets a list's scroll is cheap beside reviewing a build the PR has moved past.
 *
 * Still never while the page holds work a reload would lose — `deployArrived` waits for it
 * to land instead, and here that includes someone in a text field (`isTextField`) — and
 * still at most once a minute (`reloadAllowed`). Local is left out:
 * a built app on the Worker's port is where the worker is tried before it ships, so it
 * behaves as production does. Production, with no kind, is unchanged.
 */
export function takesDeploysAtOnce(kind: InstanceKind | undefined): boolean {
  return kind === 'dev' || kind === 'preview';
}

/**
 * Whether `el` is a field someone can be typing in, for holding a deploy back on dev and
 * previews.
 *
 * `pageBusy()` knows the note's unsent typing and nothing else, so a rename, a new tag or
 * the search box half typed is lost to a reload — the reason production waits five
 * minutes away before taking a deploy on return. Here, where a deploy is taken while the
 * page is in use, focus in such a field stands in for the hold it does not have; the
 * deploy follows as soon as it leaves. The note's title counts too, which costs only the
 * wait for a blur. Its body does not: the editor is `contenteditable`, not a field, and a
 * cursor resting in a saved note has nothing to lose.
 */
export function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (!(el instanceof HTMLInputElement)) return false;
  return !el.readOnly && !el.disabled && !NOT_TYPED.has(el.type);
}
const NOT_TYPED = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/**
 * Tells the hand-over which instance this is, from the config. Order-free with
 * `registerServiceWorker`: a deploy that was found before the config loaded, and left
 * waiting because the page was in use, is taken now if this instance takes them at once.
 * Anywhere else it does nothing, so a slow config cannot bring back a notice someone has
 * already dismissed.
 */
export function setInstanceKind(kind: InstanceKind | undefined): void {
  instanceKind = kind;
  if (takesDeploysAtOnce(kind)) deployArrived();
}

/**
 * A new deploy's worker is waiting: take it now if this moment allows, and otherwise say
 * so and leave it to a change of section, a return after a real absence, or the notice's
 * Reload.
 *
 * On an instance that takes deploys at once, a page holding one back — a save, an upload,
 * someone in a text field — is asked again every quarter second rather than left to those
 * moments. The notice waits too. The hold is usually a save a second from landing, and a
 * notice up for that second would be a flicker; but an import or an export holds the page
 * for minutes, and a tester then looked at the old build with no word that a new one was
 * waiting, which is what the notice exists to end. So it is said once the hold has lasted
 * a few seconds, once, so that dismissing it sticks, and the deploy is still taken the
 * moment the hold ends. The minute's guard still holds there, and a deploy it turns away
 * gets the notice like any other.
 */
function deployArrived(): void {
  clearTimeout(retry);
  retry = undefined;
  const worker = wb;
  if (!worker || !updateReady) return;
  const atOnce = takesDeploysAtOnce(instanceKind);
  const busy = pageBusy() || (atOnce && isTextField(document.activeElement));
  const state = { untouched, busy, path: location.pathname, kind: instanceKind };
  if (shouldApplyOnArrival(state) && reloadAllowed()) {
    updateReady = false;
    held = undefined;
    setNotice(false);
    handOver(worker, location.href);
    return;
  }
  if (busy && atOnce) {
    held ??= { since: Date.now(), said: false };
    if (sayHold(held, Date.now())) {
      held.said = true;
      setNotice(true);
    }
    retry = setTimeout(deployArrived, 250);
    return;
  }
  held = undefined;
  setNotice(true);
}

/** Whether a deploy held back on dev or a preview should now be said; see `deployArrived`. */
export function sayHold(held: { since: number; said: boolean }, now: number): boolean {
  return !held.said && now - held.since >= LONG_HOLD;
}

function watchFirstTouch(): void {
  if (watchingTouch) return;
  untouched = true;
  watchingTouch = true;
  const touched = () => {
    watchingTouch = false;
    untouched = false;
    for (const type of TOUCHES) window.removeEventListener(type, touched, true);
  };
  for (const type of TOUCHES) window.addEventListener(type, touched, { capture: true, passive: true });
}
const TOUCHES = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/*
   At most one such load a minute. If the waiting worker never takes over — a failed
   activation — `handOver` still loads the page after its timer, the old worker answers
   again, the deploy is still waiting, and without this the page would load itself every
   three seconds. The same guard as `recoverFromMissingChunks`.
*/
const UPDATED_ON_LOAD_AT = 'unbent.update-on-load';
function reloadAllowed(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(UPDATED_ON_LOAD_AT) ?? 0) < 60_000) return false;
    sessionStorage.setItem(UPDATED_ON_LOAD_AT, String(Date.now()));
    return true;
  } catch {
    // Storage refused: without the guard a failed activation could loop, so wait instead.
    return false;
  }
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
 * Whether to show that a deploy is waiting, for `UpdateSnackbar`, and the two answers to
 * it.
 *
 * The automatic moments are careful on purpose and can take a long time to come: someone
 * who keeps the notes list open and keeps using it reaches neither a change of section
 * nor five minutes away. Without a word they ran the old build with no way to know
 * there was a new one, and nothing they did would bring it. The notice says it once and
 * leaves the choice with them; it never reloads on its own.
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
 * The notice's Reload: into the waiting deploy, on the page someone is on. If the page is
 * holding work a reload would lose — a save not yet sent, an upload — it waits for that
 * to finish rather than refusing, since a press of Reload is a decision already made;
 * the note's own status says when its save is done.
 */
function reloadIntoUpdate(): void {
  setNotice(false);
  const worker = wb;
  if (!worker) return;
  const go = () => {
    // Taken meanwhile, by a change of section or a deploy taken at once (`deployArrived`).
    if (!updateReady) return;
    if (pageBusy()) {
      setTimeout(go, 250);
      return;
    }
    updateReady = false;
    handOver(worker, location.href);
  };
  go();
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
 * app after a real absence is the other moment (`checkForUpdatesOnReturn`).
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

/**
 * Lets the waiting worker take over, then loads `href` from it.
 *
 * The load waits while the page holds work a reload would lose, although every caller has
 * just checked. The worker takes a moment to take over, and on dev and previews, where a
 * deploy is taken while the page is in use, a key pressed in that moment left the note
 * unsaved with the load already on its way; its save then rested on the autosave's flush
 * racing the unload. While it waits the page is under the new worker, so a route it had not
 * loaded yet is asked of the new build, and `recoverFromMissingChunks` reloads if that
 * build no longer has it.
 */
function handOver(worker: Workbox, href: string): void {
  // Once: `controlling` and the timer can both fire, and a second `assign` on a slow
  // load would restart the navigation already under way.
  let gone = false;
  const go = () => {
    if (gone) return;
    if (pageBusy()) {
      setTimeout(go, 250);
      return;
    }
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
 * A return after a real absence is the quietest moment there is: whatever was on screen
 * was left, not mid-use. So a waiting deploy is taken then, in place, when the page holds
 * nothing a reload would lose and is not one of the Android app's embed pages. It is how
 * an app someone keeps open in one section, the notes list most of all, still reaches a
 * new deploy.
 *
 * Only after five minutes away. `visibilitychange` fires on every tab switch, every
 * un-minimise, every glance at another app on a phone; taking the deploy on all of them
 * reset a list someone was three hundred rows into because they had gone to copy
 * something, and lost text in the fields `pageBusy()` does not track, a rename or the
 * search box. A short absence keeps the page, and the deploy waits for the next change of
 * section or the next long absence.
 *
 * Asking for a new worker happens on every return, at most once a minute. The browser
 * checks on its own only when a page of the site is loaded — never, for an app that is
 * resumed rather than reopened. It was at most every half hour, on the thought that a
 * deploy is not urgent; but coming back to the tab is exactly when someone expects to find
 * one, and half an hour of the old version after a deploy read as the check being broken.
 * A check is one small request for `sw.js`, answered unchanged almost every time; the
 * minute only keeps a run of quick switches from making one each.
 *
 * After a real absence the page also counts as untouched again, as it does just after a
 * load (`shouldApplyOnArrival`): a deploy this return's check finds a few seconds later is
 * taken in place, unless someone has started using the page by then.
 */
const UPDATE_CHECK_INTERVAL = 60 * 1000;
const AWAY_FOR_UPDATE = 5 * 60 * 1000;

export function shouldApplyOnReturn(state: {
  ready: boolean;
  busy: boolean;
  path: string;
  awayFor: number;
}): boolean {
  if (!state.ready || state.busy || state.path.startsWith('/embed/')) return false;
  return state.awayFor >= AWAY_FOR_UPDATE;
}

/**
 * What a return into view does when it has not taken a waiting deploy in place: whether
 * the page counts as untouched again, and whether to ask for a new worker. Both reasons
 * are in the comment above.
 */
export function onReturn(state: { awayFor: number; sinceLastCheck: number }): { untouched: boolean; check: boolean } {
  return {
    untouched: state.awayFor >= AWAY_FOR_UPDATE,
    check: state.sinceLastCheck >= UPDATE_CHECK_INTERVAL,
  };
}

function checkForUpdatesOnReturn(worker: Workbox): void {
  let last = Date.now();
  let hiddenAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      hiddenAt = Date.now();
      return;
    }
    const awayFor = Date.now() - hiddenAt;
    const apply = shouldApplyOnReturn({
      ready: updateReady,
      busy: pageBusy(),
      path: location.pathname,
      awayFor,
    });
    if (apply) {
      updateReady = false;
      handOver(worker, location.href);
      return;
    }
    const next = onReturn({ awayFor, sinceLastCheck: Date.now() - last });
    if (next.untouched) watchFirstTouch();
    if (!next.check) return;
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
