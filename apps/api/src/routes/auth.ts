import { Hono } from 'hono';
import { getAuth } from '../auth.js';
import type { AppEnv } from '../types.js';

export const authRoutes = new Hono<AppEnv>()
  /**
   * Better Auth owns everything under /api/auth — the OAuth start and callback URLs,
   * sign-out, and session endpoints. It receives the raw Request and returns a Response.
   */
  .all('/auth/*', (c) => getAuth(c.env).handler(c.req.raw))

  /** Who am I? Returns null rather than 401 so the SPA can render a logged-out state. */
  .get('/me', (c) => c.json({ user: c.get('user') ?? null }));
