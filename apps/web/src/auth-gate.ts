import { redirect, useRouterState, type ParsedLocation } from '@tanstack/react-router';
import { ensureSession, type Session } from './auth-client.js';

/** Where the app lands when there is nowhere better to send someone. */
export const HOME = '/notes';

/** The sign-in screen's own address. */
export const LOGIN = '/login';

/**
 * Where the account-deletion mail lands once the deletion has happened.
 *
 * Named here rather than written into the route, because the API composes the link that
 * arrives at it: `sendDeleteAccountVerification` in `apps/api/src/auth.ts` pins the same
 * path. Two halves of one address, so it is worth them being findable from each other.
 */
export const GOODBYE = '/goodbye';

/**
 * Which of the three shells a path belongs to — and, because the same answer decides both,
 * whether it needs a session.
 *
 * `embed` is the Android app's WebView: it has its own chrome around the page, and it has
 * already put a session cookie in place before loading it, so an unauthenticated load is
 * reported to the app through the bridge rather than redirected to a sign-in screen inside
 * somebody else's screen.
 *
 * `plain` is the pages that exist precisely because there is no session: the sign-in
 * screen, and the far ends of the two mails that arrive when you cannot use one. Someone
 * resetting a password is by definition unable to sign in, so gating that page made the
 * reset link in the mail dead for exactly the people it was sent to. `/goodbye` is the
 * same shape taken further — the account that would have held the session is gone by the
 * time the browser arrives.
 *
 * Everything else is `app`, which is the useful default: a route added tomorrow is behind
 * the session unless somebody deliberately lists it here. One function rather than a
 * predicate beside a switch, so what renders and what is gated cannot disagree.
 */
export type Shell = 'app' | 'embed' | 'plain';

export function shellFor(pathname: string): Shell {
  if (pathname.startsWith('/embed/')) return 'embed';
  // Tolerant of a trailing slash, which a hand-typed address or an external link may carry
  // and which never means a different page.
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (path === LOGIN || path === '/reset-password' || path === GOODBYE) return 'plain';
  return 'app';
}

/**
 * The shell for what is on screen — which is not the shell for where the router is headed.
 *
 * `location` moves to the destination the moment a navigation starts, while the matches
 * it renders swap only once that route's loaders have resolved. Selecting on it therefore
 * dressed the outgoing page in the incoming page's chrome for as long as those loaders
 * took, and signing in is where that shows: the topbar and `.shell.wide` went up around
 * the still-rendered sign-in screen, and because `wide` drops the centred 46rem column
 * that `.shell` otherwise sets, the login card slid to the left edge and sat there until
 * the note list arrived. Four requests on a slow connection is seconds of a visibly
 * broken page, on the one screen a new user is guaranteed to see.
 *
 * `resolvedLocation` is the last location whose matches actually committed, so the chrome
 * and the content change in the same frame. It is undefined until the first navigation
 * resolves, where `location` is the only answer available and the correct one.
 */
export function useShell(): Shell {
  return useRouterState({ select: (s) => shellFor((s.resolvedLocation ?? s.location).pathname) });
}

/**
 * Where to come back to after signing in.
 *
 * Deep links keep their query string, which is what lets a device approval survive a
 * sign-in. `/device` without a code does not: there is nothing there to act on, and a code
 * that has since been used or has expired renders an error that looks like the sign-in
 * failed rather than like a stale link.
 */
export function returnTo(href: string): string {
  const [path, query = ''] = href.split('?');
  if (path !== '/device') return href;
  // Matched rather than parsed with the browser's query-string API, which
  // `url-boundary.test.ts` reserves for outbound API queries so that browser URL handling
  // stays the router's business.
  const hasCode = /(^|&)user_code=[^&]/.test(query);
  return hasCode ? href : HOME;
}

/**
 * The `?redirect=` on the sign-in screen, as far as it can be trusted.
 *
 * It is navigated to unread the moment someone signs in, and anything can put a value
 * there — a link in a mail, a page on another site. So only a path on this origin is
 * accepted: one leading slash and no second one, which is what rules out `//evil.example`
 * and `/\evil.example`, both of which a browser reads as another host. A scheme is
 * rejected by the same test.
 *
 * `/login` itself is refused too. It is harmless rather than dangerous — signing in would
 * land back on the sign-in screen, which then bounces to the notes — but a redirect that
 * points at its own screen is a loop waiting for a reason, and there is no version of it
 * that anyone wants.
 */
export function safeRedirect(value: string | undefined): string | undefined {
  if (!value || !value.startsWith('/') || /^\/[/\\]/.test(value)) return undefined;
  const [path = ''] = value.split('?');
  return path.replace(/\/$/, '') === LOGIN ? undefined : value;
}

/**
 * The gate in front of everything that needs a session.
 *
 * It runs in the root route's `beforeLoad`, which is the only place early enough to
 * matter: `beforeLoad` finishes for the whole matched chain before any loader starts, so
 * redirecting here is what stops `/notes` from firing its four requests without a cookie.
 *
 * That is the bug this exists to fix. The gate used to live in the root component, which
 * renders after the loaders have already run — so a signed-out visit to `/notes` 401'd
 * four times into a route nobody could see, and the first successful sign-in swapped the
 * login screen for that route's error boundary: "Something went wrong! 401 Unauthorized",
 * cleared only by reloading the page.
 *
 * `replace`, so Back leaves rather than re-entering the redirect.
 *
 * Returns the session it established, because *who* it belongs to is the caller's business
 * too: `claimCacheFor` in `queries.ts` reads the user id off it to notice the query cache
 * changing hands between two people in a tab nobody reloaded. `undefined` means this path
 * asked for no session — the two ungated shells — rather than that there is nobody.
 */
export async function requireSession(location: ParsedLocation): Promise<Session | undefined> {
  if (shellFor(location.pathname) !== 'app') return undefined;
  const session = await ensureSession();
  if (session) return session;

  const back = returnTo(location.href);
  throw redirect({
    to: LOGIN,
    // Omitted when it is where sign-in goes anyway, so the ordinary case — someone opening
    // the app signed out — gets a plain `/login` rather than a URL carrying its own default.
    search: back === HOME ? {} : { redirect: back },
    replace: true,
  });
}
