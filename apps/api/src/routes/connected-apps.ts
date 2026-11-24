import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { assistantGrantSchema } from '@unbent/shared';
import { AssistantGrantsRepo } from '../lib/assistant-grants.js';
import { ConnectedAppsRepo } from '../lib/connected-apps.js';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

/**
 * The apps connected over OAuth: what each may reach, and disconnecting one.
 *
 * Listing the connections themselves is the provider's own endpoint and needs nothing
 * here. Revoking one does: see lib/connected-apps.ts for why the plugin's
 * `delete-consent` is not enough on its own. What a connection was given (MAK-264) is
 * ours entirely, since the provider's consent has nowhere to keep it: see
 * lib/assistant-grants.ts.
 */
export const connectedApps = new Hono<AppEnv>()
  .post('/connected-apps/:consentId/disconnect', requireAuth, async (c) => {
    const repo = new ConnectedAppsRepo(c.env.DB, c.get('userId')!);
    const done = await repo.disconnect(c.req.param('consentId'));
    // 404 rather than 403 for a grant that is not this user's, as everywhere else here:
    // confirming that an id exists is itself a leak.
    if (!done) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  })
  /**
   * The connections of this account that were given less than everything, by client id.
   * One read for the whole Connected apps page; a connection absent from it is
   * unrestricted.
   */
  .get('/connected-apps/grants', requireAuth, async (c) => {
    const grants = await new AssistantGrantsRepo(c.env.DB, c.get('userId')!).list();
    return c.json({ grants });
  })
  /**
   * Sets what one client may do: from the consent screen, before it asks the provider to
   * record the consent, and from Settings afterwards. The whole grant each time, so
   * there is no partial update whose other half the server has to guess.
   *
   * By client id rather than consent id because the consent screen has no consent yet;
   * a grant for a client this account never connects is a row that grants nothing.
   */
  .put('/connected-apps/grants/:clientId', requireAuth, zValidator('json', assistantGrantSchema), async (c) => {
    const saved = await new AssistantGrantsRepo(c.env.DB, c.get('userId')!).save(c.req.param('clientId'), c.req.valid('json'));
    if (!saved) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });
