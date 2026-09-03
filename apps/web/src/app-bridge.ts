import type { SaveState } from './useAutosave.js';

/**
 * The seam between an embedded page and the native app around it.
 *
 * The Android app shows a note's body in a WebView pointed at `/embed/notes/:id`, with
 * its own title, notebook and tag controls above. The page has five things to tell the
 * app and the app has two things to ask the page, and this module is that whole
 * vocabulary, so a change to the protocol is visible from one place on the web side.
 *
 * Page to app goes through `window.UnbentApp.postMessage`, which Android installs with
 * `addJavascriptInterface` before the page loads. Absent that object — the same route
 * opened in a desktop browser during development — every post is a no-op, so the page
 * works unhosted rather than throwing on load.
 *
 * App to page is `window.__unbent.flush()`: save whatever is pending right now, because
 * the user is leaving the screen. The page answers with a `save` message like any other.
 * `abandonUploads()` comes first when the user leaves mid-upload: it drops the uploads
 * and their placeholders, so the flush that follows saves a note without them. The count
 * of uploads in flight arrives as `upload`, which is what tells the app to ask before
 * leaving at all.
 */
export type AppMessage =
  | { type: 'ready' }
  | { type: 'save'; state: SaveState }
  | { type: 'upload'; pending: number }
  | { type: 'unauthorized' }
  | { type: 'missing' };

export interface AppHandlers {
  flush(): Promise<void>;
  abandonUploads(): void;
}

declare global {
  interface Window {
    UnbentApp?: { postMessage(json: string): void };
    __unbent?: AppHandlers;
  }
}

/** Sends one message to the host app. Returns false when there is no app to hear it. */
export function postToApp(message: AppMessage): boolean {
  const app = typeof window === 'undefined' ? undefined : window.UnbentApp;
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
