import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { passkeyClient } from '@better-auth/passkey/client';

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
interface SessionState {
  data: Session | null;
  isPending: boolean;
  refetch: () => Promise<void>;
}

interface SessionStore {
  get(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
}

const sessionStore = authClient.$store.atoms.session as SessionStore;

/**
 * The session, once it is known.
 *
 * Resolves straight away when the store has already settled, and otherwise waits for the
 * first fetch to land. This is what a route guard awaits: it must not let a route's
 * loader run before it knows whether there is anybody to load for.
 */
export function ensureSession(): Promise<Session | null> {
  const current = sessionStore.get();
  if (!current.isPending) return Promise.resolve(current.data);

  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    let settled = false;
    const check = (state: SessionState) => {
      if (settled || state.isPending) return;
      settled = true;
      resolve(state.data);
      stop?.();
    };
    stop = sessionStore.subscribe(check);
    // `subscribe` calls back synchronously with the value it already has, before it has
    // returned the unsubscribe — so a store that settled between the check above and
    // here is torn down on this line instead of inside the callback.
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
