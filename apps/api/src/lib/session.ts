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
export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  try {
    const auth = getAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (session?.user) {
      c.set('userId', session.user.id);
      c.set('user', {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
      });
    }
  } catch (err) {
    console.error('Session resolution failed; continuing unauthenticated:', err);
    if (!(err instanceof APIError && err.statusCode < 500)) c.set('sessionUnavailable', true);
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
