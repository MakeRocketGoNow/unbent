import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { feedQuerySchema, snapshotQuerySchema } from '@unbent/shared';
import { isTrustedOrigin } from '../auth.js';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { storeFor } from '../lib/store-client.js';
import type { AppEnv } from '../types.js';

/**
 * The change feed: what a device asks to bring its copy of the library up to date.
 *
 * Three answers, all read-only and all the session's own store. `GET /changes` is the
 * feed after a cursor; `GET /changes/snapshot` is the whole library a page at a time, for
 * a device with no copy yet; `GET /changes/socket` is the push, a WebSocket the object
 * tells the feed's seq on after every write. The contract is `packages/shared/src/feed.ts`;
 * the reader is `UserStore.changesSince` and `snapshotPage`.
 *
 * Nothing here is cached by the service worker: these paths are not in its allowlist,
 * and a handshake never reaches it. MCP needs nothing here — its writes go through the
 * same store and record themselves.
 */
export const changes = new Hono<AppEnv>()
  .use('/changes', requireAuth, withRepos)
  .use('/changes/snapshot', requireAuth, withRepos)

  .get('/changes', zValidator('query', feedQuerySchema), async (c) => {
    const { since, limit, epoch } = c.req.valid('query');
    return c.json(await c.get('notes').changesSince(since, limit, epoch));
  })

  .get('/changes/snapshot', zValidator('query', snapshotQuerySchema), async (c) => {
    const { cursor, limit } = c.req.valid('query');
    return c.json(await c.get('notes').snapshotPage(cursor ?? null, limit));
  })

  /**
   * The upgrade goes to the object as it arrived, since a socket cannot cross RPC; the
   * object accepts it through the hibernation API (see `UserStore.fetch`). The session is
   * checked here, once, at the handshake. A session that ends later leaves the socket
   * open until the client closes it, and the socket carries only "something changed":
   * the feed itself is a GET, checked on every call.
   */
  .get('/changes/socket', requireAuth, async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected a WebSocket upgrade' }, 426);
    }
    // A handshake skips CORS and Better Auth's origin check covers only its own routes,
    // so the one thing keeping another site's page off this socket would be the session
    // cookie's SameSite default. The socket carries only "something changed", but the
    // check costs a line and does not depend on a cookie setting staying as it is. The
    // set is sign-in's own (`isTrustedOrigin`): locally that is every host the app is
    // reached on — the emulator's alias, Tailscale, another worktree's port — not the
    // one `APP_URL` names. A client with no `Origin` — a native app, the test suite — is
    // not a browser and is let through.
    const origin = c.req.header('Origin');
    if (origin !== undefined && !isTrustedOrigin(c.env, origin)) return c.json({ error: 'Forbidden' }, 403);
    return storeFor(c.env, c.get('userId')!).fetch(c.req.raw);
  });
