import { Hono } from 'hono';
import { ConnectedAppsRepo } from '../lib/connected-apps.js';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

/**
 * Disconnecting an app that was connected over OAuth.
 *
 * Listing the grants is the provider's own endpoint and needs nothing here. Revoking one
 * does: see lib/connected-apps.ts for why the plugin's `delete-consent` is not enough on
 * its own.
 */
export const connectedApps = new Hono<AppEnv>().post(
  '/connected-apps/:consentId/disconnect',
  requireAuth,
  async (c) => {
    const repo = new ConnectedAppsRepo(c.env.DB, c.get('userId')!);
    const done = await repo.disconnect(c.req.param('consentId'));
    // 404 rather than 403 for a grant that is not this user's, as everywhere else here:
    // confirming that an id exists is itself a leak.
    if (!done) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  },
);
