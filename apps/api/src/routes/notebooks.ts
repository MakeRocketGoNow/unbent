import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createFieldSchema,
  fieldTypeSchema,
  notebookNameSchema,
  reorderFieldsSchema,
  updateFieldSchema,
} from '@unbent/shared';
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

  /**
   * `unfiled` rides along because notes in no notebook have no row to be counted in, and
   * the scope selector hides its "Unfiled" option when that count is zero.
   */
  .get('/notebooks', async (c) => {
    const repo = c.get('notes');
    const [notebooks, unfiled] = await Promise.all([
      repo.listNotebooks(),
      repo.countUnfiledNotes(),
    ]);
    return c.json({ notebooks, unfiled });
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
  )

  // --- Custom fields ---------------------------------------------------------------------
  //
  // Definitions live under their notebook, addressed by id like the notebook itself. A
  // field belonging to another user's notebook is a 404 for the same reason as above.

  .get('/notebooks/:id/fields', async (c) => {
    const fields = await c.get('notes').listFields(c.req.param('id'));
    if (!fields) return c.json({ error: 'Not found' }, 404);
    return c.json({ fields });
  })

  .post('/notebooks/:id/fields', zValidator('json', createFieldSchema), async (c) => {
    const result = await c.get('notes').createField(c.req.param('id'), c.req.valid('json'));
    if (result === 'missing') return c.json({ error: 'Not found' }, 404);
    if (result === 'conflict') {
      return c.json({ error: 'A field with that name already exists in this notebook' }, 409);
    }
    if (result === 'full') return c.json({ error: 'This notebook has as many fields as it can hold' }, 400);
    return c.json(result, 201);
  })

  /**
   * Registered before `/:fieldId` so that "order" is never read as a field id. The body
   * must name every field exactly once; anything else is a stale client and gets 400.
   */
  .put('/notebooks/:id/fields/order', zValidator('json', reorderFieldsSchema), async (c) => {
    const notebookId = c.req.param('id');
    const fields = await c.get('notes').listFields(notebookId);
    if (!fields) return c.json({ error: 'Not found' }, 404);
    const ok = await c.get('notes').reorderFields(notebookId, c.req.valid('json').ids);
    if (!ok) return c.json({ error: 'The order must list every field in the notebook once' }, 400);
    return c.body(null, 204);
  })

  .patch('/notebooks/:id/fields/:fieldId', zValidator('json', updateFieldSchema), async (c) => {
    const result = await c
      .get('notes')
      .updateField(c.req.param('id'), c.req.param('fieldId'), c.req.valid('json'));
    if (result === 'missing') return c.json({ error: 'Not found' }, 404);
    if (result === 'conflict') {
      return c.json({ error: 'A field with that name already exists in this notebook' }, 409);
    }
    return c.json(result);
  })

  /** What a type change would clear, so the client can say so before doing it. */
  .get(
    '/notebooks/:id/fields/:fieldId/conversion',
    zValidator('query', z.object({ type: fieldTypeSchema })),
    async (c) => {
      const preview = await c
        .get('notes')
        .previewConversion(c.req.param('id'), c.req.param('fieldId'), c.req.valid('query').type);
      if (!preview) return c.json({ error: 'Not found' }, 404);
      return c.json(preview);
    },
  )

  /** Deletes a field and every value held under it. Not recoverable; the client confirms. */
  .delete('/notebooks/:id/fields/:fieldId', async (c) => {
    const ok = await c.get('notes').deleteField(c.req.param('id'), c.req.param('fieldId'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });
