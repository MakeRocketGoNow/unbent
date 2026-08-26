import { betterAuth } from 'better-auth';
import type { Env } from './types.js';

/**
 * Local APP_URL is always http://localhost:5173, but the SPA may be reached over
 * Tailscale (MagicDNS / 100.x). OAuth redirect_uri is derived from the request Host,
 * so a sign-in from the public Tailscale URL comes back there instead of localhost.
 * Production keeps a fixed APP_URL.
 */
function baseURLFor(env: Env) {
  if (!env.APP_URL.startsWith('http://localhost')) return env.APP_URL;
  return {
    allowedHosts: [
      'localhost:5173',
      '127.0.0.1:5173',
      '*.ts.net:5173',
      '100.*.*.*:5173',
    ],
    fallback: env.APP_URL,
    protocol: 'http' as const,
  };
}

/**
 * Better Auth must be constructed per-request: on Workers the D1 binding only exists on
 * `env`, which is not available at module scope. Instances are cheap, but we memoize per
 * Env object so repeated middleware calls within one request reuse the same instance.
 */
function createAuth(env: Env) {
  return betterAuth({
    // Better Auth v1.5+ accepts a D1 binding directly and picks its own dialect.
    // D1 has no interactive transactions; Better Auth falls back to batch() for atomicity.
    database: env.DB,
    baseURL: baseURLFor(env),
    secret: env.BETTER_AUTH_SECRET,
    // OAuth only in normal operation. The isolation suite needs to mint sessions without
    // a live OAuth provider, so ALLOW_TEST_CREDENTIALS enables password sign-up strictly
    // for local runs; it is never set in deployed environments.
    emailAndPassword: { enabled: env.ALLOW_TEST_CREDENTIALS === '1' },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
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
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      // The SPA and API are same-origin in both dev and production, so a host-only
      // cookie is sufficient and avoids SameSite=None.
      useSecureCookies: !env.APP_URL.startsWith('http://localhost'),
    },
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
