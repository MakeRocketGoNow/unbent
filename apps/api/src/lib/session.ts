import { createMiddleware } from 'hono/factory';
import { getAuth } from '../auth.js';
import type { AppEnv } from '../types.js';

/**
 * Resolves the Better Auth session and puts the user id on the context. Applied globally
 * so handlers can read `c.get('userId')`, but it does not itself reject: public routes
 * (health, the auth endpoints themselves) need to run without a session.
 */
export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
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
