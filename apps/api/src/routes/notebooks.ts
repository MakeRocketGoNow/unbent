import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { notebookNameSchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * Notebook management.
 *
 * Notebooks are addressed by id here, unlike the note list which filters by name: an id is
 * stable across a rename, and renaming is the whole reason these routes exist. Names remain
 * the interchange format everywhere they cross the app's boundary — export frontmatter, the
 * `?notebook=` filter — so an id never leaves the database's own world.
 *
 * A notebook that is not this user's returns 404 rather than 403, matching the notes
 * routes: confirming an id exists is itself a leak.
 */
const nameBody = z.object({ name: notebookNameSchema });

export const notebooks = new Hono<AppEnv>()
  .use('/notebooks', requireAuth, withRepos)
  .use('/notebooks/*', requireAuth, withRepos)

  .get('/notebooks', async (c) => {
    return c.json({ notebooks: await c.get('notes').listNotebooks() });
  })

  /** Creates an empty notebook. 409 when the name is taken, case-insensitively. */
  .post('/notebooks', zValidator('json', nameBody), async (c) => {
    const created = await c.get('notes').createNotebook(c.req.valid('json').name);
    if (!created) return c.json({ error: 'A notebook with that name already exists' }, 409);
    return c.json(created, 201);
  })

  .patch('/notebooks/:id', zValidator('json', nameBody), async (c) => {
    const result = await c
      .get('notes')
      .renameNotebook(c.req.param('id'), c.req.valid('json').name);

    if (result === 'conflict') {
      return c.json({ error: 'A notebook with that name already exists' }, 409);
    }
    if (result === 'missing') return c.json({ error: 'Not found' }, 404);
    return c.json({ id: c.req.param('id'), name: c.req.valid('json').name });
  })

  /**
   * Deletes a notebook. By default its notes survive, unfiled.
   *
   * `?trashNotes=1` also soft-deletes those notes into the trash — recoverable, not a
   * permanent wipe. Deleting an organisational label must never permanently destroy what
   * it organised; the cascade option is trash, not purge.
   */
  .delete(
    '/notebooks/:id',
    zValidator(
      'query',
      z.object({
        trashNotes: z
          .string()
          .optional()
          .transform((v) => v === '1'),
      }),
    ),
    async (c) => {
      const ok = await c
        .get('notes')
        .deleteNotebook(c.req.param('id'), { trashNotes: c.req.valid('query').trashNotes });
      if (!ok) return c.json({ error: 'Not found' }, 404);
      return c.body(null, 204);
    },
  );
