import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
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
   */
  plugins: [passkeyClient(), emailOTPClient()],
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
