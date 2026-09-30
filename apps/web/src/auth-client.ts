import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { forgetSession, rememberSession, rememberedSession } from './session-memory.js';
import { clearOfflineCaches } from './offline-cache.js';

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
 * does a *different* user arriving — those copies are keyed by address, not by account
 * (`offline-cache.ts`). Resolves once they are gone, so the guard can hold a route's
 * loaders until nothing of the previous account can be served.
 */
export function recordSession(state: Pick<SessionState, 'data' | 'error' | 'isPending'>): Promise<void> {
  if (state.data) {
    const previous = rememberedSession();
    rememberSession(state.data.user);
    if (previous && previous.user.id !== state.data.user.id) return clearOfflineCaches();
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
 */
export function ensureSession(): Promise<Session | null> {
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    let settled = false;
    const finish = (state: SessionState, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      checkAbandoned = timedOut && state.isPending;
      const { session } = answerFor(state, rememberedSession());
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
