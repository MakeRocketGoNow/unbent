import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer, deviceAuthorization, oneTimeToken } from 'better-auth/plugins';
import type { AuthProvider } from '@unbent/shared';
import type { Env } from './types.js';

/**
 * Emails permitted to create an account, lowercased.
 *
 * Empty means unrestricted, which is what local development wants. Deployed, this is set
 * so that a public URL does not turn into a free notes host for anyone who finds it:
 * OAuth alone would happily sign up any Google or GitHub account in the world.
 */
function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether password sign-in is offered.
 *
 * Two switches for one feature, on purpose. AUTH_PASSWORD is the self-hoster's choice:
 * social providers need a callback URL registered per deployment with Google and GitHub,
 * which nobody can do on behalf of every instance, so a password is the one method that
 * works everywhere. ALLOW_TEST_CREDENTIALS stays as the test suite's own switch — it is
 * documented as local-only, and folding it into the real flag would invite setting the
 * real flag on a deployed instance "for the tests".
 */
function passwordEnabled(env: Env): boolean {
  return env.AUTH_PASSWORD === '1' || env.ALLOW_TEST_CREDENTIALS === '1';
}

/**
 * The sign-in methods this instance offers, in display order.
 *
 * Derived from the same checks `createAuth` makes, so the login screen and the Android
 * app can render from it rather than guessing. The screen used to hardcode Google and
 * GitHub, which only failed at the moment of pressing a button with no credentials behind
 * it. Public, because it is needed before anyone is signed in; nothing here is secret,
 * since a provider's presence is discoverable by trying it.
 */
export function offeredProviders(env: Env): AuthProvider[] {
  const providers: AuthProvider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) providers.push('google');
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) providers.push('github');
  if (passwordEnabled(env)) providers.push('password');
  return providers;
}

/**
 * Local APP_URL is always http://localhost:5173, but the SPA may be reached over
 * Tailscale (MagicDNS / 100.x). OAuth redirect_uri is derived from the request Host,
 * so a sign-in from the public Tailscale URL comes back there instead of localhost.
 * Production keeps a fixed APP_URL.
 *
 * These are also the origins Better Auth trusts, so the Android emulator's alias for
 * the host machine has to be here: the app sends it as `Origin`, and without it every
 * sign-in from an emulator is refused as CSRF with "Invalid origin".
 */
function baseURLFor(env: Env) {
  if (!env.APP_URL.startsWith('http://localhost')) return env.APP_URL;
  return {
    allowedHosts: [
      'localhost:5173',
      '127.0.0.1:5173',
      '10.0.2.2:5173',
      '*.ts.net:5173',
      '100.*.*.*:5173',
    ],
    fallback: env.APP_URL,
    protocol: 'http' as const,
  };
}

/**
 * What this module actually uses of a Better Auth instance: the catch-all request handler
 * mounted at /api/auth/*, and the session lookup sessionMiddleware performs.
 *
 * Declared explicitly because the plugins below make the inferred return type reference
 * better-call, a transitive dependency this package does not depend on directly, which
 * TypeScript rejects as unportable (TS2742). Naming the surface we rely on is better than
 * pinning someone else's dependency to satisfy a type it only mentions in passing — and it
 * fails loudly if a future caller reaches for something not listed here.
 */
interface AuthInstance {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (context: { headers: Headers }) => Promise<{
      user?: { id: string; email: string; name: string; image?: string | null };
    } | null>;
  };
}

/**
 * Better Auth must be constructed per-request: on Workers the D1 binding only exists on
 * `env`, which is not available at module scope. Instances are cheap, but we memoize per
 * Env object so repeated middleware calls within one request reuse the same instance.
 */
function createAuth(env: Env): AuthInstance {
  return betterAuth({
    // Better Auth v1.5+ accepts a D1 binding directly and picks its own dialect.
    // D1 has no interactive transactions; Better Auth falls back to batch() for atomicity.
    database: env.DB,
    baseURL: baseURLFor(env),
    secret: env.BETTER_AUTH_SECRET,
    // Off unless the instance asks for it; see passwordEnabled. The sign-up allowlist
    // below applies to password accounts exactly as it does to OAuth ones.
    emailAndPassword: { enabled: passwordEnabled(env) },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              /**
               * An array widens *ID token audience* verification only — the browser's
               * authorization-code flow still uses the first entry with the secret below.
               *
               * The Android app signs in with Credential Manager, which returns a token
               * issued for whichever client id it asked for. That is normally this same web
               * id, so the extra entry is only needed if a build ever asks for a separate
               * Android audience; accepting both means neither choice breaks sign-in.
               */
              clientId: env.GOOGLE_ANDROID_CLIENT_ID
                ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_ANDROID_CLIENT_ID]
                : env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
    },
    /**
     * The allowlist gate.
     *
     * Hooked on user *creation* rather than sign-in, so it costs nothing on the ordinary
     * path: existing users never touch it, and an account that was never created cannot
     * sign in. Throwing beats returning `false`, which Better Auth turns into a null
     * create the caller reports as a generic failure — this way the visitor is told they
     * are not on the list rather than seeing something that looks like a bug.
     */
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email?: string }) => {
            const allowed = allowedEmails(env);
            if (allowed.length === 0) return;
            const email = user.email?.toLowerCase();
            if (email && allowed.includes(email)) return;
            throw new APIError('FORBIDDEN', {
              message: 'This Unbent instance is not open for sign-ups.',
            });
          },
        },
      },
    },
    session: {
      // Thirty days, slid forward at most once a day — so ordinary use keeps a session
      // alive indefinitely and only a month of genuine absence signs you out.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      /**
       * Serve the session from a signed cookie for five minutes before re-reading D1.
       *
       * Without this every request that touches auth hits the database, and a failed or
       * cold read surfaces as a sign-out rather than a slow request — the most likely
       * explanation for sessions that lapsed well before their recorded expiry, which in
       * the local database was always a full thirty days.
       *
       * Signed with the same secret, and a read-through cache only: revocation still
       * takes effect within `maxAge`.
       */
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    advanced: {
      // The SPA and API are same-origin in both dev and production, so a host-only
      // cookie is sufficient and avoids SameSite=None.
      useSecureCookies: !env.APP_URL.startsWith('http://localhost'),
    },
    plugins: [
      /**
       * Lets a CLI sign in without ever handling a credential: it prints a short code,
       * the user approves it in a browser already signed in here, and the CLI collects an
       * ordinary session. Nothing is typed into or stored by the CLI.
       *
       * Approval requires a real session, so the sign-up allowlist above governs this
       * path too — a device cannot be authorized by someone who could not sign in.
       *
       * Defaults are the plugin's: a 30-minute code and 5-second polling. Both suit a
       * migration the user starts and then watches.
       */
      deviceAuthorization(),
      /**
       * Accepts `Authorization: Bearer <token>` as an alternative to the session cookie.
       *
       * The device flow issues a normal session; without this the CLI would have to
       * store and replay a cookie, which is the browser's mechanism rather than an HTTP
       * client's. Everything downstream is unchanged either way — sessionMiddleware still
       * resolves a user and `requireAuth` still guards the same routes.
       */
      bearer(),
      /**
       * Lets a signed-in browser hand a session to a native app without the user reading
       * anything out.
       *
       * The phone opens /connect in a Custom Tab, which is already signed in through the
       * browser's own cookies whatever provider was used to get there — Google, GitHub, or
       * anything added later. That page mints one of these, and the app redeems it for an
       * ordinary session. The device-code flow stays for the CLI, which has no browser to
       * hand anything back to.
       *
       * Three minutes is the plugin's default and is right here: the token's whole life is
       * one redirect back into the app.
       */
      oneTimeToken(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const cache = new WeakMap<Env, Auth>();

export function getAuth(env: Env): Auth {
  const existing = cache.get(env);
  if (existing) return existing;
  const auth = createAuth(env);
  cache.set(env, auth);
  return auth;
}
