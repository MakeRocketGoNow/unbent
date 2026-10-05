/**
 * What the browser hands the installed app when it launches it: files, or a link.
 *
 * The manifest's `launch_handler` is `focus-existing`, so a launch aimed at an app that is
 * already open brings its window forward and changes nothing else — no navigation, no
 * reload. What the launch was for arrives on `window.launchQueue` instead, and is dropped
 * unless the page takes it. Two kinds arrive:
 *
 * - **Files**, from the manifest's `file_handlers`: a PDF opened with the app, or a
 *   scanner's "send to application". Each becomes a note (`launch-files.ts`).
 * - **A link**, from link capturing: a note's address clicked in a chat app or another
 *   tab. Chrome sends any in-scope link to the open app, and the window came forward on
 *   the note it was already showing — the consumer only took files, and returned on a
 *   launch with none. The link is opened here, through the router.
 *
 * `focus-existing` rather than `navigate-existing`, which would do the link without any of
 * this: that loads the window again on every captured link, losing the list's place and
 * an editor's state, and sends every scan through a load of `/notes` before its note
 * opens. `setConsumer` takes one consumer per page, so both kinds are handled by this one.
 *
 * A browser tab has no launch queue, and nothing here runs then.
 */

/** The queue Chromium exposes; not in the DOM lib yet. */
interface LaunchParams {
  files: readonly FileSystemFileHandle[];
  /** The address the launch was for: the clicked link, or `file_handlers.action`. */
  targetURL?: string;
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}
declare global {
  interface Window {
    launchQueue?: LaunchQueue;
  }
}

export interface LaunchHandlers {
  /** The files of one launch, already read; becomes a note. */
  files: (files: File[]) => Promise<void>;
  /** A path on this site to show, as from `launchPath`. */
  link: (path: string) => void;
  /**
   * The path, query and fragment showing now. The router's history, not `window.location`,
   * so the router stays the one owner of the address (`url-boundary.test.ts`).
   */
  showing: () => string;
}

export function installLaunchQueue(handlers: LaunchHandlers): void {
  const queue = window.launchQueue;
  if (!queue) return;
  /*
   * The address this page was loaded at, taken before the router has had a chance to
   * redirect it. A cold launch is delivered here too, with the address the window was
   * opened at — which the router is already showing, or has redirected from on purpose:
   * `/` to the notes, a signed-out visitor to the sign-in page. Opening it again would
   * fight the redirect, so the first launch is skipped when it is for this address.
   */
  const loadedAt = window.location.href;
  let first = true;
  queue.setConsumer(async (params) => {
    const cold = first;
    first = false;
    if (params.files.length > 0) {
      try {
        await handlers.files(await Promise.all(params.files.map((handle) => handle.getFile())));
      } catch (err) {
        console.error('launch-files', err);
      }
      // The launch's address is `file_handlers.action`, not somewhere the person asked
      // to go: the note made from the files is where they are taken.
      return;
    }
    if (!params.targetURL || (cold && params.targetURL === loadedAt)) return;
    const path = launchPath(params.targetURL, window.location.origin);
    if (path === undefined || path === handlers.showing()) return;
    handlers.link(path);
  });
}

/**
 * The path on this site to show for a launch's address; undefined for another site's.
 *
 * A file's address — `/api/notes/<id>/files/<name>`, which is what copying an attachment
 * puts on the clipboard (`attachment-clipboard.ts`) — is the Worker's, not a page of the
 * app, so it opens the note the file belongs to. Loading the file itself would put a bare
 * PDF where the app was, with no way back but the window's own; the note has the file one
 * tap away. Every other address is handed on whole, for the caller to open in place or
 * load.
 */
export function launchPath(target: string, origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  const file = /^\/api\/notes\/([^/]+)\/files\/./.exec(url.pathname);
  if (file) return `/notes/${file[1]}`;
  return url.pathname + url.search + url.hash;
}
