import { isOfflineError } from './notes-api.js';
import { offlineNow, subscribeConnectivity } from './connectivity.js';

/**
 * What a note says where a file's preview would be, when the device is offline and holds
 * no copy of the file: a plain line, at once. Not a spinner that never ends, not a broken
 * image, not "Couldn't render this PDF" — nothing is wrong with the file, and the person
 * can do something about it next time: open it while online, or keep its notebook.
 *
 * One phrase and one way of deciding, shared by everything that draws a file — the rich
 * editor's widgets, the preview pane, the full-screen viewer — so a note cannot say it
 * three ways. In the note's body, never in its head (the head stays one word).
 */
export const NOT_AVAILABLE_OFFLINE = 'Not available offline';

/**
 * Whether a file that failed to load failed for want of a connection. From the error when
 * there is one (a fetch through `request` throws `OfflineError`), and otherwise from what
 * the app and the browser already believe: an `<img>` reports that it failed, never why.
 */
export function unavailableOffline(err?: unknown): boolean {
  return isOfflineError(err) || offlineNow() || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

/** Runs `fn` once, the next time the app is back online. Returns a way to stop waiting. */
export function whenBackOnline(fn: () => void): () => void {
  const stop = subscribeConnectivity(() => {
    if (offlineNow()) return;
    stop();
    fn();
  });
  return stop;
}

/** The line itself, for the places that build DOM by hand. `name` says which file, where nothing else on screen does. */
export function unavailableLine(name?: string): HTMLSpanElement {
  const line = document.createElement('span');
  line.className = 'file-unavailable';
  line.textContent = name ? `${name} · ${NOT_AVAILABLE_OFFLINE}` : NOT_AVAILABLE_OFFLINE;
  return line;
}

/**
 * Stands the line in for a picture that failed to load offline, and puts the picture
 * back when the connection returns. Answers false, having done nothing, when the failure
 * was not for want of a connection — a missing file is the caller's to handle as before.
 * `onCleanup` is handed the way to stop waiting, for a caller whose element can go away.
 */
export function standInForImage(img: HTMLImageElement, name: string, onCleanup?: (stop: () => void) => void): boolean {
  if (!unavailableOffline()) return false;
  const line = unavailableLine(name);
  // Both: `hidden` for what reads the DOM, and the style because a stylesheet that gives
  // pictures a `display` — the editor's, the preview's — outranks the attribute.
  img.hidden = true;
  img.style.display = 'none';
  img.insertAdjacentElement('afterend', line);
  const stop = whenBackOnline(() => {
    line.remove();
    img.hidden = false;
    img.style.display = '';
    // Assigning the address again is what makes the browser ask for it again.
    const src = img.getAttribute('src');
    if (src) img.setAttribute('src', src);
  });
  onCleanup?.(stop);
  return true;
}
