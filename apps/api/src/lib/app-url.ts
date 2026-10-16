import type { Env, RawEnv } from '../types.js';

/**
 * The origin this instance is served on, settled before any route runs.
 *
 * `APP_URL` is the one value everything about identity hangs from: Better Auth's base
 * URL, the trusted origins, the passkey relying party, secure cookies, the MCP resource
 * and issuer, the host the legal documents print. It used to be required, and had to be
 * named in the deploy configuration, which meant every deployment had to know its own
 * address before it existed. A Worker on a workers.dev subdomain does not: the address is
 * only printed by the first deploy. The Deploy to Cloudflare flow has the same problem one
 * step earlier.
 *
 * So when nothing has set it, the answer is the origin the request arrived on. That is
 * trustworthy on Workers for a reason that has nothing to do with the Host header: a
 * request only reaches this Worker on a hostname that routes to it (its workers.dev name,
 * or a custom domain attached to it), so the origin is one the operator chose, never one a
 * caller made up. Local development already trusts the request origin the same way, for
 * Tailscale and the emulator; see `baseURLFor` in auth.ts.
 *
 * The one thing derivation cannot decide is which of two origins is *the* one. A Worker
 * reachable on both a custom domain and its workers.dev name behaves as two instances of
 * the same data, each with its own cookies and passkeys. An operator who wants a single
 * front door sets `APP_URL` explicitly (a secret is the durable place, since a deploy
 * replaces plain vars) and then the other door refuses every sign-in as an untrusted
 * origin, exactly as before.
 *
 * Memoized per origin rather than built per request, because `getAuth` keys its Better
 * Auth instance on the identity of the env object it is handed. A fresh object each time
 * would construct Better Auth on every request and fire the open-sign-up warning with it.
 * A configured env passes through untouched, so that path is byte-for-byte what it was.
 */
const views = new Map<string, Env>();

/** Enough for a Worker with a custom domain and a workers.dev name; anything more is a bug. */
const MAX_ORIGINS = 8;

export function withAppUrl(env: RawEnv, request: Request): Env {
  const configured = env.APP_URL?.trim();
  if (configured) return env as Env;

  const origin = new URL(request.url).origin;
  const existing = views.get(origin);
  if (existing) return existing;

  if (views.size >= MAX_ORIGINS) views.clear();
  const view: Env = { ...env, APP_URL: origin };
  views.set(origin, view);
  return view;
}
