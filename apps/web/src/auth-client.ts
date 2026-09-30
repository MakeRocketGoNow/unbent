import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { passkeyClient } from '@better-auth/passkey/client';
import {
  clearSignOutPending,
  forgetSession,
  markSignOutPending,
  pendingSignOut,
  rememberSession,
  rememberedSession,
} from './session-memory.js';
import { clearOfflineCaches } from './offline-cache.js';
import { offlineNow, reportUnreachable, subscribeConnectivity } from './connectivity.js';

/**
 * Same-origin in both dev (Vite proxy) and production (Pages routes /api to the Worker),
 * so the default baseURL of the current origin is correct and cookies travel normally.
 *
 * Deliberately not exported. Its inferred type reaches into `@better-auth/core`, which
 * this package does not depend on directly, and TypeScript rejects naming that in an
 * export as unportable (TS2742) — the same problem `apps/api/src/auth.ts` documents. There
 * it is solved by declaring the small surface that module uses; here the surface is the
 * whole plugin-extended client, which would be brittle to restate and would need editing
 * on every plugin change. Keeping the instance local sidesteps it: the calls below are
 * what callers want anyway, and nothing outside this module referenced it.
 */
const authClient = createAuthClient({
  basePath: '/api/auth',
  /**
   * The passkey plugin is what puts `signIn.passkey` and the `passkey.*` management calls
   * on this client. It does the WebAuthn dance with the browser — challenge, credential,
   * assertion — none of which is worth hand-rolling against `navigator.credentials`.
   *
   * The email-OTP plugin adds `emailOtp.sendVerificationOtp` and `signIn.emailOtp`. Both
   * are declared here whatever the instance offers: what a client can *call* is separate
   * from what the sign-in screen draws, which follows `/api/config`.
   *
   * The OAuth provider plugin adds `oauth2.*`, which the consent screen needs — and, less
   * visibly, a fetch hook that carries the signed authorization query along with every
   * request that needs it. Signing in *during* an authorization flow depends on that hook:
   * without it the provider has no way to know which authorization the new session belongs
   * to, and the flow stops at the sign-in screen instead of resuming.
   */
  plugins: [passkeyClient(), emailOTPClient(), oauthProviderClient()],
});

export const {
  signIn,
  signUp,
  signOut,
  deleteUser,
  useSession,
  passkey,
  emailOtp,
  requestPasswordReset,
  resetPassword,
} = authClient;

/**
 * The two OAuth calls the consent screen makes, named explicitly.
 *
 * `oauth2` cannot be re-exported the way `passkey` and `emailOtp` are: its inferred type
 * reaches into `@better-auth/oauth-provider`'s bundled internals, which TypeScript refuses
 * to name in an export as unportable (TS2883, the same family as the TS2742 the instance
 * above documents). Restating the whole surface would be brittle, so this declares only
 * what the consent screen calls — which is also a useful statement of how small that is.
 */
export interface ConsentClient {
  /**
   * Public metadata for the client asking for access, for the screen to name it.
   *
   * Snake_case because these are the OAuth registration fields as RFC 7591 spells them,
   * returned as the client registered them, rather than anything this codebase names.
   */
  publicClient: (options: { query: { client_id: string } }) => Promise<{
    data?: { client_name?: string | null; client_uri?: string | null; logo_uri?: string | null } | null;
    error?: { message?: string } | null;
  }>;
  /** Approve or refuse. On approval the provider sends the browser on to the client. */
  consent: (options: { accept: boolean }) => Promise<{
    data?: { redirect?: boolean; url?: string } | null;
    error?: { message?: string } | null;
  }>;
  /** Every app this user has approved, for the Connected apps page to list. */
  getConsents: () => Promise<{
    data?: Array<{ id: string; clientId: string; scopes?: string[]; createdAt?: string }> | null;
    error?: { message?: string } | null;
  }>;
}

export const oauth2 = authClient.oauth2 as unknown as ConsentClient;

/**
 * The signed-in user, as much of the session as this app ever reads.
 *
 * Written out rather than inferred, for the reason the client instance above is not
 * exported: the inferred type reaches into `@better-auth/core`, which this package does
 * not depend on directly, and TypeScript refuses to name that in an export (TS2742).
 */
export interface Session {
  user: { id: string; email: string; name?: string };
  /** The server's record of this sign-in, which a sign-out made offline ends later by id. */
  session?: { id: string };
}

/**
 * The same session `useSession` reads, reachable from outside React.
 *
 * Better Auth keeps the session in a nanostore and `useSession` is that store read
 * through a hook. The router needs the same value where hooks cannot go — a `beforeLoad`
 * guard runs before anything renders — so the two functions below read the store rather
 * than calling `getSession()`. `getSession()` would work, but it fetches on its own and
 * writes nowhere, so the guard and the hook would hold two answers that drift apart: the
 * guard would let a navigation through while the chrome around it still showed a login
 * screen, or the reverse.
 *
 * `$store.atoms` is the client's own escape hatch for exactly this, and its values are
 * typed `any`, so the part of the shape these functions depend on is declared here.
 * Subscribing is what mounts the store, and mounting is what starts the first fetch —
 * which is why `ensureSession` subscribes rather than polling `get()`.
 */
export interface SessionState {
  data: Session | null;
  /**
   * Why the last check failed. A refusal from the server carries its `status`; a request
   * that never arrived is the `TypeError` fetch threw, which has none.
   */
  error: { status?: number } | null;
  isPending: boolean;
  refetch: () => Promise<void>;
}

interface SessionStore {
  get(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
}

const sessionStore = authClient.$store.atoms.session as SessionStore;

/**
 * How long the guard waits for the session check before treating the server as out of
 * reach.
 *
 * The check has no timeout of its own — Better Auth hands its fetch an abort signal, which
 * turns off the fetch library's timer — so on a connection that is up but carries nothing,
 * the guard used to wait for as long as the operating system kept the socket open, with the
 * app showing nothing at all. Ten seconds is the same bound the app's own requests use.
 */
export const SESSION_CHECK_TIMEOUT = 10_000;

/**
 * What the session check's state says about who is signed in.
 *
 * Only the server can say nobody is: a 401, or an answer with no session in it. Anything
 * else — a request that never arrived, a check still waiting when the guard gave up, a
 * server error that is not a refusal — says only that the server could not be asked, and
 * then the app carries on as whoever was last signed in on this device (`session-memory`).
 * With nobody remembered there is nothing to carry on as, and the answer is the same
 * "nobody" it always was.
 *
 * `unreachable` is true whenever the answer is the remembered one, for the chrome that
 * has to say so.
 */
export function answerFor(
  state: Pick<SessionState, 'data' | 'error' | 'isPending'>,
  remembered: Session | null,
): { session: Session | null; unreachable: boolean } {
  if (state.data) return { session: state.data, unreachable: false };
  const refused = !state.isPending && (state.error == null || state.error.status === 401);
  if (refused) return { session: null, unreachable: false };
  return { session: remembered, unreachable: remembered !== null };
}

/**
 * Whether the guard gave up waiting on a check that is still in flight. Read by
 * `useAppSession`, so the chrome does not sit on "Loading…" behind a guard that has
 * already let the page through.
 */
let checkAbandoned = false;

export const sessionCheckAbandoned = () => checkAbandoned;

/**
 * Keeps the device in step with what the server says about who is signed in: remembers
 * the user when there is one, forgets them when the server says there is nobody, and
 * leaves both alone when it could not be asked.
 *
 * Forgetting also empties what the service worker kept of their notes and files, and so
 * does anyone arriving who is not the user this device remembers — those copies are keyed
 * by address, not by account (`offline-cache.ts`). Resolves once they are gone, so the
 * guard can hold a route's loaders until nothing of the previous account can be served.
 *
 * "Not the remembered user" includes nobody remembered at all, which is every first sign-in
 * after a sign-out. Clearing at sign-out is not enough on its own: a read the worker had
 * in flight when the page deleted the caches still writes its answer when it lands, which
 * puts the previous account's rows back. It costs a delete of nothing on most sign-ins.
 */
export function recordSession(state: Pick<SessionState, 'data' | 'error' | 'isPending'>): Promise<void> {
  if (state.data) {
    const previous = rememberedSession();
    rememberSession(state.data.user);
    if (previous?.user.id !== state.data.user.id) return clearOfflineCaches();
    return Promise.resolve();
  }
  if (!state.isPending && (state.error == null || state.error.status === 401)) {
    forgetSession();
    return clearOfflineCaches();
  }
  return Promise.resolve();
}

/**
 * The session, once it is known — or, when the server cannot be asked, whoever was last
 * signed in on this device.
 *
 * Resolves straight away when the store has already settled, and otherwise waits for the
 * first fetch to land, for at most `SESSION_CHECK_TIMEOUT`. This is what a route guard
 * awaits: it must not let a route's loader run before it knows whether there is anybody
 * to load for, and it must not send someone to sign in because their phone has no signal.
 * See `answerFor` for which failures mean which.
 *
 * When the browser already says there is no network and someone is remembered, it does
 * not wait at all. Airplane mode on Android is the case: the WebView's request did not
 * fail fast there, it hung, and the app opened to a blank page for the whole ten seconds
 * before the timeout let it through. The check still runs, and its answer is still
 * recorded when it lands, so a session the server has since refused is caught the next
 * time it can be asked.
 */
export async function ensureSession(): Promise<Session | null> {
  const pending = pendingSignOut();
  if (pending === null) return checkSession();
  return finishSignOut(pending);
}

/**
 * Ends the session a sign-out made offline could not (`pendingSignOut`), and until it
 * has, answers that nobody is signed in — the person asked to leave, and the device must
 * not carry on as them.
 *
 * With no network nothing is asked. Online, the session check says which session the
 * cookie belongs to: the pending one is ended now; any other — someone signed in again
 * since — is left alone and the pending one forgotten, since there is no longer a cookie
 * for it on this device. Whatever the check remembered of the old user is forgotten again.
 */
async function finishSignOut(pending: string): Promise<null | Session> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const answer = await checkSession();
  const state = sessionStore.get();
  if (state.data?.session?.id !== pending) {
    // The server answered for another session, or for none: nothing left to end.
    if (state.data || !state.error || state.error.status === 401) clearSignOutPending();
    return state.data ? answer : null;
  }
  forgetSession();
  await clearOfflineCaches();
  const ended = await Promise.race([
    signOut().then((res) => !res?.error, () => false),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), SESSION_CHECK_TIMEOUT)),
  ]);
  if (ended) {
    clearSignOutPending();
    // Emptied before anything reads it: the store still holds the session just ended, and
    // `/login`'s loader, asking next, would wave the person back into the notes — whose
    // loaders then fail with the dead cookie — until Better Auth's own refetch caught up.
    // The same reason `useSignOut` refreshes before it navigates.
    await refreshSession().catch(() => null);
  }
  return null;
}

/**
 * Records that the current session must be ended the next time the server can be asked —
 * a sign-out that could not reach it. See `finishSignOut`.
 */
export function endSessionLater(): void {
  const id = sessionStore.get().data?.session?.id;
  if (id) markSignOutPending(id);
}

/** The session check itself, as `ensureSession` describes it. */
function checkSession(): Promise<Session | null> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    let settled = false;
    const remembered = rememberedSession();
    if (typeof navigator !== 'undefined' && navigator.onLine === false && remembered && sessionStore.get().isPending) {
      checkAbandoned = true;
      reportUnreachable();
      resolve(remembered);
      return;
    }
    /*
       A store that has already settled is answering from an earlier check. After a cold
       start offline that answer is the network error from then, and Better Auth keeps it
       until something asks again (`installSessionRecheck`) — so it says nothing about the
       connection now, and treating it as news put the app back offline on every
       navigation once the connection had returned.
    */
    const settledBefore = !sessionStore.get().isPending;
    const finish = (state: SessionState, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      checkAbandoned = timedOut && state.isPending;
      const { session, unreachable } = answerFor(state, rememberedSession());
      // A check that never got an answer is the first sign the connection is gone; one the
      // server answered with an error is not, and must not raise the offline banner. Only
      // a check made during this call counts, or one abandoned by the timeout.
      const fresh = timedOut || !settledBefore;
      if (fresh && unreachable && state.error?.status === undefined) reportUnreachable();
      void recordSession(state).then(() => resolve(session));
      stop?.();
    };
    const timer = setTimeout(() => finish(sessionStore.get(), true), SESSION_CHECK_TIMEOUT);
    stop = sessionStore.subscribe((state) => {
      if (!state.isPending) finish(state, false);
    });
    // `subscribe` calls back synchronously with the value it already has, before it has
    // returned the unsubscribe — so a store that had already settled is torn down on this
    // line instead of inside the callback.
    if (settled) stop();
  });
}

/**
 * Asks for the session again when the app comes back online, if the last check never got
 * an answer.
 *
 * Better Auth asks again by itself only on the browser's `online` event and on focus. On a
 * phone leaving airplane mode that `online` request often lands before the radio carries
 * anything and fails too, and the store then holds that failure for as long as the app
 * stays in front — the app believed in a server it could reach and a session it could
 * not confirm. This follows the app's own connectivity (`connectivity.ts`), which knows
 * the server is back from a real answer, and asks once on each return.
 */
export function installSessionRecheck(): () => void {
  let wasOffline = offlineNow();
  return subscribeConnectivity(() => {
    const offline = offlineNow();
    if (wasOffline && !offline) {
      const state = sessionStore.get();
      if (!state.data && state.error && state.error.status === undefined) void state.refetch();
    }
    wasOffline = offline;
  });
}

/**
 * Fetch the session again, and wait for the answer.
 *
 * Signing in and signing out both have to do this before navigating. Better Auth does
 * refetch on its own when a sign-in call returns, but only while the store is mounted and
 * only on its own schedule — so a guard reading the store a moment later can still see
 * the session that was just replaced, and send the user back where they came from. It
 * costs one request at the two moments where being wrong is visible.
 */
export async function refreshSession(): Promise<Session | null> {
  await sessionStore.get().refetch();
  return sessionStore.get().data;
}
