import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { exposeToApp, isHosted, postToApp } from './app-bridge.js';
import { HOME } from './auth-gate.js';
import { WORKER_PREFIXES } from './sw/routes.js';

/**
 * The signed-in site's half of being hosted by the app, on Android or iOS. Does nothing
 * in a browser.
 *
 * Mounted once, in the signed-in shell, because everything here is about the site as a
 * whole rather than one page: the colour around it, and what Back, a swipe back and a
 * notification tap mean wherever the person happens to be.
 */
export function useHostApp(): void {
  const router = useRouter();

  /*
   * The page's ground, for the app to paint the status and navigation bar strips with.
   *
   * The app keeps the page out from under the system bars — a WebView tells a page nothing
   * about the insets, so the topbar and every sheet would otherwise need to learn them —
   * and draws those strips itself. In the page's own colour they read as the page running
   * to the edge; in the app's theme colour they read as a frame around it. Sent again when
   * the phone switches between light and dark, since the page's colour follows the system.
   */
  useEffect(() => {
    if (!isHosted()) return;
    const post = () => {
      const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (background) postToApp({ type: 'theme', background });
    };
    post();
    const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    scheme?.addEventListener('change', post);
    return () => scheme?.removeEventListener('change', post);
  }, []);

  useEffect(() => {
    if (!isHosted()) return;
    return exposeToApp({
      back: (canGoBack) => back(canGoBack, router.state.location.pathname, (to) =>
        void router.navigate({ to, replace: true }),
      ),
      open: (path) => {
        // A path on this site and nothing else: the app rebases links onto the instance
        // before asking, so anything else here is a mistake to refuse, not follow.
        if (!path.startsWith('/') || path.startsWith('//')) return false;
        if (servedByWorker(path)) return false;
        void router.navigate({ href: path });
        return true;
      },
    });
  }, [router]);

  /*
   * A sheet must not outlive the page it was opened over.
   *
   * `back` above is how Android keeps that true: the app asks before it moves, and the
   * page closes what is on top instead. iOS's swipe from the edge asks nobody — WKWebView
   * walks its own history and the page hears of it only as `popstate` — so the same
   * promise is kept after the fact: the history has moved, and whatever was open over
   * the page that was left closes. All of it, and with `close` rather than
   * `requestClose`: a sheet may decline a request, and there is no longer a page under
   * it to stay on. On Android this finds nothing to do, since the app walks the history
   * only once `back` has said nothing is open.
   *
   * Only when the address changed. The attachment viewer pushes an entry of its own at
   * the address it was opened on and answers `popstate` itself; leaving that entry — by
   * the gesture or by its ✕, which pops it — is the viewer closing, not the page under it
   * going away, and a sheet the viewer was opened from stays.
   *
   * A known difference from Android, and not this handler's to fix. The filter sheet's
   * pickers — tags, dates, fields — add a history entry for each change while the sheet
   * stays open, so that a browser's Back undoes a filter. A swipe back with that sheet
   * open therefore undoes the last change and closes the sheet in one gesture, where
   * Android's Back only closes the sheet. The gesture cannot be refused, and the address
   * did change, so closing is right as far as this handler can tell. If the difference
   * is ever worth removing, the place is those pickers, navigating with `replace` while
   * a sheet is open — which also changes what Back does in every browser, and is why it
   * was not done alongside this.
   *
   * Heard from the router's history rather than from `popstate`. The event says where
   * the history arrived and nothing about where it left, so telling a move from the
   * viewer's entry means remembering the last address, and a listener on the window
   * cannot keep that memory straight: the router answers the same event, and by the time
   * a second listener ran it had already settled on the new page — tried, and in the
   * running app no sheet ever closed. The history reports every change in one place, a
   * navigation as a push or a replace and a walk as back, forward or go, so the address
   * is followed through the first kind and acted on for the second.
   */
  useEffect(() => {
    if (!isHosted()) return;
    let here = router.history.location.href;
    return router.history.subscribe(({ location, action }) => {
      const moved = location.href !== here;
      here = location.href;
      if (moved && action.type !== 'PUSH' && action.type !== 'REPLACE') closeDialogs();
    });
  }, [router]);
}

/**
 * What is open over the page, in document order, so the last is the one on top. One place
 * for what counts, since Back and a swipe back must agree on it.
 */
function openDialogs(): HTMLDialogElement[] {
  return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
}

/** Closes every open dialog, the one on top first, as leaving them one at a time would. */
function closeDialogs(): void {
  for (const dialog of openDialogs().reverse()) dialog.close();
}

/*
 * Paths the Worker answers before the site sees them: `run_worker_first` in
 * `apps/api/wrangler.toml`, held to it by a test beside `WORKER_PREFIXES` — the service
 * worker leaves the same paths alone.
 *
 * `open` refuses these rather than hand them to the router, which has no route for them
 * and would draw its not-found page. A link in a note to an attachment's address is the
 * case that reaches here. Refused, the caller falls back to what it did before `open`
 * existed: the editor opens a new tab, and the app loads the address.
 */

function servedByWorker(path: string): boolean {
  return WORKER_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Android's Back, as the page answers it. True when the page handled it.
 *
 * Here rather than in the app because only the page knows what is on top of it. A
 * WebView never delivers Back to the page, so a sheet — the phone's drawer, the filters,
 * the move-to and tag pickers — would otherwise stay open while the history behind it
 * moved, and the next thing the person saw would be the sheet over a different page.
 *
 * In order:
 *
 * 1. An open dialog closes. `requestClose` where the WebView has it, because that is the
 *    path Escape takes and a sheet may decline it; `close` otherwise, which every sheet
 *    answers through its `close` event. The attachment viewer is a dialog too, and closing
 *    it pops the history entry it pushed, so it leaves exactly as the ✕ does.
 * 2. With nothing behind this page in the WebView's history — the app was opened on a note
 *    from a notification or a link — Back goes to the list, the way Android's own apps
 *    build a back stack for a screen opened from outside. `replace`, so Back from the list
 *    then leaves the app rather than coming back here.
 * 3. Otherwise false, and the app walks the history or goes to the background.
 */
export function back(canGoBack: boolean, pathname: string, goHome: (to: string) => void): boolean {
  const top = openDialogs().at(-1);
  if (top) {
    const closable = top as HTMLDialogElement & { requestClose?: () => void };
    if (typeof closable.requestClose === 'function') closable.requestClose();
    else top.close();
    return true;
  }
  if (!canGoBack && pathname !== HOME) {
    goHome(HOME);
    return true;
  }
  return false;
}
