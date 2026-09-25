import type { SaveState } from './useAutosave.js';

/**
 * The seam between this site and the Android app that hosts it.
 *
 * The app shows the whole site in one WebView and keeps native code only for what a page
 * cannot do on a phone: the share sheet, sign-in through the phone's own account sheet,
 * the file picker and camera, and saving files into Downloads. It also loads
 * `/embed/index-files` off screen after a capture, to extract a PDF's text with the
 * extractor this site has. Everything a page can tell the app and everything the app can
 * ask a page is this module's vocabulary, so a change to the protocol is visible from one
 * place on the web side. The app's half is `NoteBridge.kt`.
 *
 * Page to app goes through `window.UnbentApp.postMessage`, which Android installs with
 * `addJavascriptInterface` before the page loads. Absent that object — the site in any
 * browser — every post is a no-op, so the page works unhosted rather than throwing.
 *
 * - `theme` carries the page's ground colour, so the strips the app draws around the page
 *   (behind the status bar and the navigation bar) are the same colour as the page.
 * - `unauthorized` says the page believes the session is gone. The app checks before it
 *   believes it, because the page cannot tell a dead session from no network.
 * - `signed-out` is the person signing out on the page; the app forgets its copy of the
 *   session too and goes to its own sign-in screen.
 * - `app-settings` asks for the app's own settings, which hold what only the app has: the
 *   address of the instance it talks to, and its version.
 *
 * App to page is `window.__unbent`, installed by the signed-in shell (`useHostApp`):
 *
 * - `back(canGoBack)` is Android's Back. The page closes what is on top of it, if
 *   anything, and says whether it did; otherwise the app walks the WebView's history. See
 *   `useHostApp` for why the page decides this rather than the app.
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
 * reaches Downloads (`export-archive.ts`); they are synchronous on purpose, so a page
 * writing faster than the phone's storage waits for it rather than queueing gigabytes.
 * Optional, because only a version of the app that hosts the whole site has them.
 */
export interface HostApp {
  postMessage(json: string): void;
  saveBegin?(name: string, type: string): string;
  saveChunk?(id: string, base64: string): boolean;
  saveEnd?(id: string): boolean;
  saveAbort?(id: string): void;
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

/** Whether this page is running inside the Android app. */
export function isHosted(): boolean {
  return hostApp() !== undefined;
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
