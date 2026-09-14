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
 * being down rather than a request that should be retried. Swallowing it here degrades a
 * protected route to `requireAuth`'s 401 (recoverable, and what an absent session already
 * produces) and leaves a public one working, while the log keeps the failure visible.
 *
 * Deliberately not narrowed to a particular error: whatever makes the session unresolvable
 * — a D1 timeout, a malformed cookie, a Better Auth internal — the right response is the
 * same as no session, never a 500.
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
  }

  await next();
});

/**
 * Rejects unauthenticated requests. Mount on every route that touches user data; the
 * repos downstream cannot be constructed without the id this guarantees.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('userId')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
