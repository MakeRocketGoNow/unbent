import { redirect, useRouterState, type ParsedLocation } from '@tanstack/react-router';
import { ensureSession, type Session } from './auth-client.js';
import { postToApp } from './app-bridge.js';

/** Where the app lands when there is nowhere better to send someone. */
export const HOME = '/notes';

/** The sign-in screen's own address. */
export const LOGIN = '/login';

/**
 * The two ends of the account-deletion mail: the page that asks, and the page that reports.
 *
 * `CONFIRM_DELETE` is the address the API composes into the link
 * (`confirmDeletionUrl` in `apps/api/src/auth.ts` builds it from APP_URL), so the two halves
 * are worth being findable from each other. Neither can be behind the session gate for the
 * same underlying reason: one has to explain itself to a browser that is not signed in,
 * and by the time the other renders there is no account left to be signed in to.
 */
export const CONFIRM_DELETE = '/delete-account';
export const GOODBYE = '/goodbye';

/**
 * The public explanation of how to delete an account: the address the Play listing points
 * at, and no part of the mail flow above.
 *
 * Worth not confusing with `CONFIRM_DELETE`, which the name deliberately keeps at arm's
 * length: that page spends a token and destroys an account, this one acts on nothing and
 * is written for someone who may not have an account at all. Play requires the deletion
 * process be documented at a URL that loads without signing in, which is the whole reason
 * this is a page rather than a section of `/privacy`.
 */
export const HOW_TO_DELETE = '/delete-my-account';

/**
 * Which of the three shells a path belongs to, and, because the same answer decides both,
 * whether it needs a session.
 *
 * `embed` is the page the Android app loads off screen to index a capture's PDFs. The app
 * has already put a session cookie in place before loading it, so an unauthenticated load
 * is reported to the app through the bridge rather than redirected to a sign-in screen
 * nobody would see.
 *
 * `plain` is the pages that have to render for someone with no session, enumerated in
 * `PUBLIC` below. Two kinds. Some exist precisely because there is no session: the sign-in
 * screen, and the far ends of the two mails that arrive when you cannot use one: gating
 * the reset page made the link in that mail dead for exactly the people it was sent to,
 * `/delete-account` has to be able to say "you are not signed in here" rather than
 * redirect and lose the token from view, and `/goodbye` is reached when the account that
 * would have held the session is already gone.
 *
 * The legal pages are the other kind: read by people who have no account and never will.
 * The Play listing links to the privacy policy, so it cannot sit behind a sign-in.
 *
 * `front` is the bare root, described at `FRONT` below.
 *
 * Everything else is `app`, which is the useful default: a route added tomorrow is behind
 * the session unless somebody deliberately lists it here. One function rather than a
 * predicate beside a switch, so what renders and what is gated cannot disagree.
 */
export type Shell = 'app' | 'embed' | 'plain' | 'front';

/**
 * The bare root: the front page for a signed-out visitor on the public instance, and only
 * a doorway everywhere else.
 *
 * A shell of its own rather than one more `PUBLIC` path, because `plain` centres a narrow
 * card on an empty page and the front page is a page, full width, with its own header. It
 * is ungated for the same reason the sign-in screen is (the person it is for has no
 * session), and the route decides the rest: someone signed in goes to `HOME`, and an
 * instance with no front page sends everyone else to `LOGIN`. See `routes/index.tsx`.
 */
export const FRONT = '/';

/**
 * The front page's pricing section, as an address of its own.
 *
 * Paddle's website review asks for a pricing page and refuses a bare domain. `/pricing`
 * is a page of only the offer (`routes/pricing.tsx`), in the front page's shell and
 * ungated for the same reason the front page is: the reviewer following it has no
 * session. Unlike the bare root it is not a doorway: someone signed in who asks for the
 * pricing page gets the pricing page, not their notes. It was a redirect to `FRONT` at
 * first, and a signed-in person landing in their notes read it as a bug.
 */
export const PRICING = '/pricing';

/**
 * The pages that render without a session, listed rather than inferred.
 *
 * Two kinds, and both are here because gating them broke something specific. The sign-in
 * screen and the far end of a reset mail exist precisely because there is no session: a
 * gate on the reset page made the link dead for the only people who ever receive one.
 *
 * The public documents are the other kind: they have to be readable by someone who has no
 * account and never will, because the Play listing links to them and Play checks that the
 * links load. `HOW_TO_DELETE` is here for a failure that already happened: the listing's
 * deletion URL pointed at `/settings/maintenance`, and the console answered 403, because
 * the reviewer following it has no session. A redirect to a sign-in screen is the wrong
 * answer to all of these.
 */
const PUBLIC: ReadonlySet<string> = new Set([
  LOGIN,
  '/reset-password',
  CONFIRM_DELETE,
  GOODBYE,
  '/privacy',
  '/terms',
  HOW_TO_DELETE,
  // The preview sign-in relay's landing point. Public for the same reason as the sign-in
  // screen: it is reached with no session (a token from the dev instance is about to
  // establish one), so gating it would redirect the token to /login and lose it. See
  // routes/preview-signin.tsx.
  '/preview-signin',
]);

export function shellFor(pathname: string): Shell {
  if (pathname.startsWith('/embed/')) return 'embed';
  // Tolerant of a trailing slash, which a hand-typed address or an external link may carry
  // and which never means a different page.
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (path === FRONT || path === PRICING) return 'front';
  if (PUBLIC.has(path)) return 'plain';
  return 'app';
}

/**
 * The shell for what is on screen, which is not the shell for where the router is headed.
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
 * there: a link in a mail, a page on another site. So only a path on this origin is
 * accepted: one leading slash and no second one, which is what rules out `//evil.example`
 * and `/\evil.example`, both of which a browser reads as another host. A scheme is
 * rejected by the same test.
 *
 * `/login` itself is refused too. It is harmless rather than dangerous (signing in would
 * land back on the sign-in screen, which then bounces to the notes) but a redirect that
 * points at its own screen is a loop waiting for a reason, and there is no version of it
 * that anyone wants.
 */
export function safeRedirect(value: string | undefined): string | undefined {
  if (!value || !value.startsWith('/') || /^\/[/\\]/.test(value)) return undefined;
  const [path = ''] = value.split('?');
  return path.replace(/\/$/, '') === LOGIN ? undefined : value;
}

/**
 * Where the browser was heading before the preview sign-in relay took it away, parked
 * across the round trip through the dev instance.
 *
 * It cannot ride in the URL. The dev instance validates the relay's `return` as a *bare*
 * origin (no path, no query) and relaxing that to carry a destination would widen the one
 * check the whole relay's safety rests on. Storage instead, and `sessionStorage` rather than
 * the `localStorage` `usePersistentState` uses, because this belongs to one handoff in one
 * tab rather than to the person.
 *
 * Every access is wrapped: a browser with storage disabled must still be able to sign in,
 * and losing the destination costs only a landing on `/notes`. It lives here rather than in
 * the route that reads it so the sign-in screen does not have to import a route module to
 * write it.
 */
const RELAY_REDIRECT_KEY = 'unbent.preview-relay.redirect';

export function rememberRelayRedirect(path: string): void {
  try {
    sessionStorage.setItem(RELAY_REDIRECT_KEY, path);
  } catch {
    // Storage disabled or full. The destination is a nicety; signing in is not.
  }
}

/** Reads and clears it. Through `safeRedirect` for the same reason `/login`'s is. */
export function takeRelayRedirect(): string {
  try {
    const stored = sessionStorage.getItem(RELAY_REDIRECT_KEY);
    sessionStorage.removeItem(RELAY_REDIRECT_KEY);
    return safeRedirect(stored ?? undefined) ?? HOME;
  } catch {
    return HOME;
  }
}

/**
 * The gate in front of everything that needs a session.
 *
 * It runs in the root route's `beforeLoad`, which is the only place early enough to
 * matter: `beforeLoad` finishes for the whole matched chain before any loader starts, so
 * redirecting here is what stops `/notes` from firing its four requests without a cookie.
 *
 * That is the bug this exists to fix. The gate used to live in the root component, which
 * renders after the loaders have already run, so a signed-out visit to `/notes` 401'd
 * four times into a route nobody could see, and the first successful sign-in swapped the
 * login screen for that route's error boundary: "Something went wrong! 401 Unauthorized",
 * cleared only by reloading the page.
 *
 * `replace`, so Back leaves rather than re-entering the redirect.
 *
 * Returns the session it established, because *who* it belongs to is the caller's business
 * too: `claimCacheFor` in `queries.ts` reads the user id off it to notice the query cache
 * changing hands between two people in a tab nobody reloaded. `undefined` means this path
 * asked for no session (the ungated shells) rather than that there is nobody.
 */
export async function requireSession(location: ParsedLocation): Promise<Session | undefined> {
  if (shellFor(location.pathname) !== 'app') return undefined;
  const session = await ensureSession();
  if (session) return session;

  // Inside the Android app, sign-in is the app's own screen, which offers the phone's
  // account sheet; the one below would be a second sign-in form inside it. The redirect
  // still happens, so the page never renders a route it cannot load, but it is the app
  // that decides what comes next, and it checks first. `ensureSession` no longer answers
  // null for a phone with no signal when it knows who was signed in (see `answerFor`), but
  // it still does on a device that has never remembered anyone.
  postToApp({ type: 'unauthorized' });

  const back = returnTo(location.href);
  throw redirect({
    to: LOGIN,
    // Omitted when it is where sign-in goes anyway, so the ordinary case (someone opening
    // the app signed out) gets a plain `/login` rather than a URL carrying its own default.
    search: back === HOME ? {} : { redirect: back },
    replace: true,
  });
}
