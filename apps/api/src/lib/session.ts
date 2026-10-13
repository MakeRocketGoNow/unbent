import { APIError } from 'better-auth/api';
import { createMiddleware } from 'hono/factory';
import { getAuth } from '../auth.js';
import type { AppEnv } from '../types.js';

/**
 * Resolves the Better Auth session and puts the user id on the context. Applied globally
 * so handlers can read `c.get('userId')`, but it does not itself reject: public routes
 * (health, the auth endpoints themselves) need to run without a session.
 *
 * Failing to *resolve* a session is treated the same as not having one, rather than being
 * allowed to throw. `getSession` reads D1 (the session row, and the database-backed rate
 * limiter), so a transient read blip would otherwise escape to the global `onError` as a
 * 500 on *every* request — including this middleware's own reason for existing, the public
 * routes it is meant to let through. That is the wrong blast radius: a momentary auth-store
 * hiccup took the unauthenticated health check down with it, which read as the whole API
 * being down rather than a request that should be retried. Swallowing it here leaves a
 * public route working, while the log keeps the failure visible.
 *
 * A protected route is told the truth instead: the session could not be checked, which is
 * not the same as there being none. It used to get `requireAuth`'s 401, and 401 means
 * "signed out" to every client — the phone clears its session on one and deletes the
 * shares it had queued, the web returns to the sign-in screen. The failure that produces
 * it is the database refusing reads, most of all on a day the Workers Free quota runs out,
 * when every request fails the same way for hours; signing everyone out then turned an
 * outage that fixes itself at midnight UTC into lost captures and a sign-in nobody could
 * complete. `sessionUnavailable` lets `requireAuth` answer 503 with a Retry-After, which
 * clients already treat as an error to retry.
 *
 * Narrowed by who is at fault, not by what went wrong. Better Auth catches every failure
 * inside `getSession` and rethrows it as an `APIError`: its own store failing — the D1
 * refusal above, a timeout — comes out as a 500, while a 4xx is Better Auth deciding this
 * client's session is no good (the row deleted between reading and refreshing it). A 503
 * tells the client to keep retrying, which is only honest when retrying can work; a 4xx
 * would fail the same way forever, leaving the client stuck on "try again shortly" with no
 * way back to the sign-in screen, so it is answered as no session instead. Anything that is
 * not an `APIError` at all never reached Better Auth's own handling and is treated as the
 * store, not the client. A malformed or wrongly signed cookie does not throw — better-call
 * reads it as no cookie and `getSession` resolves null — so it was never in question.
 */
/**
 * How long resolving the session may take before the request goes on without one. On
 * 2026-10-13 every request carrying one person's real session cookie sat in `getSession`
 * for the better part of ten minutes, repeatedly, while requests with no cookie or a fake
 * one answered in under a second and D1 answered in under a millisecond; the invocations
 * ended only when the browser gave up on them. The web app read its timed-out health
 * check as the device being offline, and the person saw "You're offline" with a working
 * connection, lists that never filled, and a navigation that emptied and refilled.
 * Bounded, a stall is a 503 with Retry-After on a protected route and a plain answer on
 * a public one, both of which every client already retries. The stall itself is logged
 * with its duration and the cookies' names, so the next one says which path hung.
 */
export const SESSION_CHECK_MS = 8_000;
/** Slower than this is said in the log, so a stall that resolves still leaves a trace. */
const SLOW_SESSION_MS = 2_000;

class SessionCheckTimeout extends Error {
  constructor() {
    super(`Resolving the session took longer than ${SESSION_CHECK_MS} ms`);
    this.name = 'SessionCheckTimeout';
  }
}

/** Which of Better Auth's cookies the request carried, by name: the cached session, the token, or neither. */
function cookieShape(headers: Headers): string {
  const names = (headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')[0] ?? '').filter(Boolean);
  const auth = names.filter((n) => n.includes('better-auth'));
  return auth.length ? auth.join(',') : 'none';
}

export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const started = Date.now();
  try {
    const auth = getAuth(c.env);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const session = await Promise.race([
      auth.api.getSession({ headers: c.req.raw.headers }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SessionCheckTimeout()), SESSION_CHECK_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const took = Date.now() - started;
    if (took >= SLOW_SESSION_MS) console.warn(`[session] resolved in ${took} ms (cookies: ${cookieShape(c.req.raw.headers)}, user: ${session?.user ? 'yes' : 'no'})`);

    if (session?.user) {
      c.set('userId', session.user.id);
      c.set('user', {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
        legalVersion: session.user.legalVersion ?? null,
      });
    }
  } catch (err) {
    if (err instanceof SessionCheckTimeout) {
      console.error(`[session] ${err.message} (cookies: ${cookieShape(c.req.raw.headers)}); continuing unauthenticated`);
      c.set('sessionUnavailable', true);
    } else {
      console.error('Session resolution failed; continuing unauthenticated:', err);
      if (!(err instanceof APIError && err.statusCode < 500)) c.set('sessionUnavailable', true);
    }
  }

  await next();
});

/**
 * Rejects unauthenticated requests. Mount on every route that touches user data; the
 * repos downstream cannot be constructed without the id this guarantees. A session that
 * could not be looked up is a 503, not a 401 — see `sessionMiddleware`.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('userId')) {
    if (c.get('sessionUnavailable')) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Your session could not be checked right now. Try again shortly.' }, 503);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
