import type { SaveState } from './useAutosave.js';

/**
 * The seam between this site and the app hosting this page (Android or iOS).
 *
 * The app shows the whole site in one web view and keeps native code only for what a page
 * cannot do on a phone: the share sheet, sign-in through the phone's own account sheet,
 * the file picker and camera, and saving files where the phone keeps them. It also loads
 * `/embed/index-files` off screen after a capture, to extract a PDF's text with the
 * extractor this site has. Everything a page can tell the app and everything the app can
 * ask a page is this module's vocabulary, so a change to the protocol is visible from one
 * place on the web side. The Android app's half is `NoteBridge.kt`.
 *
 * Page to app goes through `window.UnbentApp`, which the app puts there before the page
 * loads: Android with `addJavascriptInterface`, whose methods answer synchronously, and
 * an iOS host from a script of its own over WKWebView's message handlers, which can only
 * answer with a promise. This module is written to the weaker of the two, so the page
 * never asks which it is talking to: a call that returns something may return it or a
 * promise of it (see `HostApp`). Absent that object — the site in any browser — every
 * post is a no-op, so the page works unhosted rather than throwing.
 *
 * - `theme` carries the page's ground colour, so the strips the app draws around the page
 *   (behind the status bar and the navigation bar) are the same colour as the page.
 * - `unauthorized` says the page believes the session is gone. The app checks before it
 *   believes it, because the page cannot tell a dead session from no network.
 * - `signed-out` is the person signing out on the page; the app forgets its copy of the
 *   session too and goes to its own sign-in screen.
 * - `app-settings` asks for the app's own settings, which hold what only the app has: the
 *   address of the instance it talks to, and its version.
 * - `edge-to-edge` says this page lays itself out around the screen's safe area, so the
 *   app may run it under the status bar and the home indicator. See `adoptHostLayout`.
 *
 * App to page is `window.__unbent`, installed by the signed-in shell (`useHostApp`):
 *
 * - `back(canGoBack)` is Android's Back. The page closes what is on top of it, if
 *   anything, and says whether it did; otherwise the app walks the web view's history. See
 *   `useHostApp` for why the page decides this rather than the app, and for what stands
 *   in for it where the host walks the history without asking.
 * - `open(path)` navigates in place, for a notification or a link that names a note while
 *   the app is already open. Reloading the site instead would throw away an upload in
 *   flight on the note that was open.
 *
 * The indexing page says `ready`, then `index-progress` as it goes, and ends with exactly
 * one of `index-done`, `unauthorized` or `index-error`. The app has nothing to ask it.
 *
 * `save`, `upload`, `missing`, `flush` and `abandonUploads` belong to the embedded note
 * page (`/embed/notes/:id`) that earlier versions of the app drew their own screen around.
 * They stay until those versions are gone from the store; see that route.
 */
export type AppMessage =
  | { type: 'ready' }
  | { type: 'save'; state: SaveState }
  | { type: 'upload'; pending: number }
  | { type: 'unauthorized' }
  | { type: 'missing' }
  | { type: 'signed-out' }
  | { type: 'app-settings' }
  | { type: 'edge-to-edge' }
  | { type: 'theme'; background: string }
  | { type: 'index-progress'; done: number; total: number }
  | { type: 'index-done'; indexed: number; unusable: number; failed: number }
  | { type: 'index-error'; message: string };

export interface AppHandlers {
  /** Handled Back: true when the page closed or moved something, false to leave it to the app. */
  back?(canGoBack: boolean): boolean;
  /** Navigates to a path on this site without reloading it. True when it did. */
  open?(path: string): boolean;
  flush?(): Promise<void>;
  abandonUploads?(): void;
}

/**
 * The app's side, as the page sees it. `saveBegin` and the calls after it are how an export
 * reaches the phone's storage (`export-archive.ts`). Optional, because only a version of
 * the app that hosts the whole site has them.
 *
 * Each answers with a value or a promise of one, because the two hosts cannot agree:
 * Android's `@JavascriptInterface` methods return when the write is done, and WKWebView
 * has no synchronous call from a page at all. Either way the answer is the backpressure —
 * a page writing faster than the phone's storage waits for it rather than queueing
 * gigabytes — so a caller must wait for each answer before making the next call. A host
 * must not answer `saveChunk` before the piece is written, or that wait means nothing.
 * `saveAbort` has nothing to answer, but an iOS host's call still comes back as a promise,
 * which may reject; a caller waits for it and has nothing to do about a failure.
 */
export interface HostApp {
  /**
   * Which app this is, for the few places where the page's words depend on it. Absent on
   * Android: `addJavascriptInterface` exposes methods and nothing else, and versions of
   * that app in the store predate the question. So only an iOS host has to say, and a
   * host that says nothing is Android.
   */
  platform?: 'android' | 'ios';
  postMessage(json: string): void;
  saveBegin?(name: string, type: string): string | Promise<string>;
  saveChunk?(id: string, base64: string): boolean | Promise<boolean>;
  saveEnd?(id: string): boolean | Promise<boolean>;
  saveAbort?(id: string): void | Promise<void>;
}

declare global {
  interface Window {
    UnbentApp?: HostApp;
    __unbent?: AppHandlers;
  }
}

/** The app hosting this page, or undefined in a browser. */
export function hostApp(): HostApp | undefined {
  return typeof window === 'undefined' ? undefined : window.UnbentApp;
}

/** Whether this page is running inside the app, on either platform. */
export function isHosted(): boolean {
  return hostApp() !== undefined;
}

/**
 * Where the app puts a file it saves, as the phone names the place: an export lands in
 * Android's Downloads, and on iOS in the Files app. For copy only — the page hands over
 * the same bytes either way.
 */
export function savesTo(): 'Downloads' | 'Files' {
  return hostApp()?.platform === 'ios' ? 'Files' : 'Downloads';
}

/** Sends one message to the host app. Returns false when there is no app to hear it. */
export function postToApp(message: AppMessage): boolean {
  const app = hostApp();
  if (!app) return false;
  app.postMessage(JSON.stringify(message));
  return true;
}

/**
 * Registers what the app may call. Returns the deregistration, which only removes the
 * handlers it installed: a later page's registration must not be torn down by an earlier
 * page's unmount racing it.
 */
export function exposeToApp(handlers: AppHandlers): () => void {
  window.__unbent = handlers;
  return () => {
    if (window.__unbent === handlers) delete window.__unbent;
  };
}

/**
 * What the iOS app's page adds to its viewport: the whole screen, and no zooming it did
 * not ask for.
 *
 * The second half is here because of what WebKit does unasked. Tapping Attach with the
 * keyboard up put the picker's menu on screen with the page magnified to about one and
 * three-quarter times behind it — the title cut off, the docked bar halfway up — until
 * the menu was dismissed. A web view zooms toward whatever it has just focused, and it
 * does so freely unless the page says its scale is fixed. `maximum-scale=1` is what stops
 * that. A pinch still works: the app sets `ignoresViewportScaleLimits`, as Safari does,
 * so the limit binds WebKit and never the person. `user-scalable=no` was here at first
 * and took pinch-zoom from anyone who needs it to read a scan, which was the wrong trade
 * for stopping a stray thumb.
 */
const IOS_VIEWPORT = 'viewport-fit=cover, maximum-scale=1.0';

/**
 * Lays the page out for the app hosting it. Called once, before anything renders.
 *
 * Only the iOS app asks anything of the layout. It first kept the page inside the safe
 * area and painted the strips above and below in the page's colour, as the Android app
 * does — and on a phone with a Dynamic Island those strips are tall enough to show:
 * the drawer and the scrim behind it stopped short of the top and bottom of the screen,
 * and the drawer read as a card floating between two bands. No native iOS app's side
 * panel does that. So inside that app the page takes the whole screen and keeps its own
 * content clear of the clock and the home indicator, which is what `viewport-fit=cover`
 * and the `env(safe-area-inset-*)` rules under `html.host-ios` in styles.css are.
 *
 * The page says so (`edge-to-edge`) rather than the app assuming it: an instance running
 * a deploy from before this would otherwise be laid out under the status bar with nothing
 * in its stylesheet to move it down. The app gives a page the whole screen only once that
 * page has asked.
 *
 * Android keeps its strips. They are a status bar and a gesture bar high, the WebView
 * tells a page nothing about them, and its drawer's rounded corners are Material's own.
 */
export function adoptHostLayout(): void {
  if (hostApp()?.platform !== 'ios') return;
  document.documentElement.classList.add('host-ios');
  const viewport = document.querySelector('meta[name="viewport"]');
  const content = viewport?.getAttribute('content') ?? '';
  // Each setting by its own key, so a second call adds nothing and a page that already
  // says `viewport-fit` still gets the scale. Checking for `viewport-fit` alone once
  // stood for all of them, and would have brought the zoom back silently the day
  // index.html gained `viewport-fit=cover` of its own.
  const missing = IOS_VIEWPORT.split(', ').filter((part) => !content.includes(`${part.split('=')[0]}=`));
  if (viewport && missing.length) {
    viewport.setAttribute('content', [content, ...missing].join(', '));
  }
  postToApp({ type: 'edge-to-edge' });
  // The same function each time, so calling this twice still listens once.
  window.addEventListener('pageshow', askAgainOnRestore);
}

/**
 * A page WebKit brings back from its back/forward cache — an edge swipe back across a
 * full load — is a new document to the app, which puts every new document inside the
 * safe area until it asks. But a restored page does not run its scripts again: it still
 * has `host-ios` and its own insets, and without this it would sit inside the app's strips
 * as well, with two gaps at the top. So it asks again, as `store/library.ts` reopens its
 * database on the same event.
 */
function askAgainOnRestore(event: PageTransitionEvent): void {
  if (event.persisted) postToApp({ type: 'edge-to-edge' });
}
