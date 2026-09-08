import { Hono } from 'hono';
import type { AppConfig } from '@unbent/shared';
import { accountDeletionOffered, getAuth, offeredProviders } from '../auth.js';
import { legalLinksOf, operatorOf } from '../lib/instance.js';
import type { AppEnv } from '../types.js';

export const authRoutes = new Hono<AppEnv>()
  /**
   * Better Auth owns everything under /api/auth — the OAuth start and callback URLs,
   * sign-out, and session endpoints. It receives the raw Request and returns a Response.
   */
  .all('/auth/*', (c) => getAuth(c.env).handler(c.req.raw))

  /** Who am I? Returns null rather than 401 so the SPA can render a logged-out state. */
  .get('/me', (c) => c.json({ user: c.get('user') ?? null }))

  /**
   * What this instance offers. Public by necessity: a login screen has to know which
   * buttons to draw before there is a session. See `offeredProviders`.
   *
   * `accountDeletion` is here for the same reason the providers are — a control the server
   * would answer with a 404 should not be drawn. It is not a permission: the endpoint
   * enforces itself, and this only says whether asking it is worth the user's time.
   *
   * `operator` and `legal` are the same idea applied to the legal documents, which used to
   * be constants naming one company. A self-hosted instance that has not said who runs it
   * publishes no documents and draws no links to them — see lib/instance.ts.
   *
   * `satisfies` rather than a return annotation: the fields whose value is `undefined` are
   * dropped by `JSON.stringify` on the way out, which is exactly the "absent means not
   * offered" reading the client already applies to `accountDeletion`.
   */
  .get('/config', (c) =>
    c.json({
      providers: offeredProviders(c.env),
      accountDeletion: accountDeletionOffered(c.env),
      operator: operatorOf(c.env),
      legal: legalLinksOf(c.env),
    } satisfies AppConfig),
  );
