import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createViewSchema, updateViewSchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * Saved views (MAK-249): a notebook's list the way someone left it, under a name. What a
 * view is, and why it is per notebook, is in `views.ts` in `@unbent/shared`; the store's
 * half is `store/views.ts`.
 *
 * A router of its own at `/views` rather than under `/notebooks/:id/views`. A view
 * belongs to a notebook, and the body says which, but every device reads all of an
 * account's views at once (the rail lists them under each notebook, and the feed carries
 * them as one collection), and an edit or a delete names the view alone; nesting would
 * make every call name a notebook the store does not need to find the view. It also
 * leaves room for the library views the store already allows, which have no notebook to
 * be nested under.
 *
 * Each route is one store call, since each is a billable object request. A view that is
 * not this account's is a 404, as everywhere here: it is not in this account's store, so
 * the store cannot tell it from one that never existed, and confirming an id exists
 * elsewhere would be a leak.
 *
 * The plan: a create and an edit are held to the free plan in the store (`HELD_IN_STORE`
 * in lib/plan-middleware.ts), as a notebook's management is; a delete is exempt, as
 * every delete is.
 */
const TAKEN = 'A view with that name already exists';

export const views = new Hono<AppEnv>()
  .use('/views', requireAuth, withRepos)
  .use('/views/*', requireAuth, withRepos)

  /** Every view of the account, by notebook in its order. */
  .get('/views', async (c) => {
    return c.json({ views: await c.get('notes').listViews() });
  })

  /**
   * Saves a view at the end of its notebook's. 404 for a notebook that is not this
   * account's; 409 for a name another of the notebook's views has, without case.
   */
  .post('/views', zValidator('json', createViewSchema), async (c) => {
    const { notebookId, name, query } = c.req.valid('json');
    const created = await c.get('notes').createView(notebookId, name, query);
    if (created === 'missing') return c.json({ error: 'Not found' }, 404);
    if (created === 'conflict') return c.json({ error: TAKEN }, 409);
    return c.json(created, 201);
  })

  /**
   * Renames a view, replaces its query, or moves it among its notebook's views. Answers
   * the view as it now is, since a move changes its position to one the store decides
   * (a position past the end is the end).
   */
  .patch('/views/:id', zValidator('json', updateViewSchema), async (c) => {
    const updated = await c.get('notes').updateView(c.req.param('id'), c.req.valid('json'));
    if (updated === 'missing') return c.json({ error: 'Not found' }, 404);
    if (updated === 'conflict') return c.json({ error: TAKEN }, 409);
    return c.json(updated);
  })

  .delete('/views/:id', async (c) => {
    const ok = await c.get('notes').deleteView(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });
