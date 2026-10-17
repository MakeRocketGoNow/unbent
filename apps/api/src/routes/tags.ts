import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { tagColorSchema, tagNameSchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * Tag management: rename, recolour and delete.
 *
 * Tags had no management surface at all: they existed only as a side effect of the
 * notes that carried them, and the only way to fix a misspelt tag across three hundred
 * notes was to open three hundred notes. Listing stays on the notes routes, where it has
 * always been; these are the mutations, addressed by id like a notebook's, since an
 * id is stable across the rename that is the whole point.
 *
 * A tag that is not this user's is a 404 rather than a 403, matching every other route:
 * confirming an id exists is itself a leak.
 */

/**
 * A new name, a new colour, or both. The colour is an index into the palette
 * (`tagColorSchema`); the Tags page sends it alone from the swatches beside the name.
 */
const patchBody = z
  .object({ name: tagNameSchema.optional(), color: tagColorSchema.optional() })
  .refine((b) => b.name !== undefined || b.color !== undefined, 'Nothing to change');

export const tags = new Hono<AppEnv>()
  .use('/tags/*', requireAuth, withRepos)

  /**
   * Renames or recolours a tag. A rename is 409 when another tag already has the name,
   * unless `?merge=1`, which folds this tag into that one: the client confirms first,
   * because it cannot be undone. A colour is written first, so a rename that merges
   * applies it to the row that goes (and the survivor keeps its own), which is what
   * "recolour and merge" can only mean.
   */
  .patch(
    '/tags/:id',
    zValidator('json', patchBody),
    zValidator(
      'query',
      z.object({
        merge: z
          .string()
          .optional()
          .transform((v) => v === '1'),
      }),
    ),
    async (c) => {
      const { name, color } = c.req.valid('json');
      const id = c.req.param('id');
      if (color !== undefined && !(await c.get('notes').recolorTag(id, color))) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (name === undefined) return c.json({ id, color });
      const result = await c.get('notes').renameTag(id, name, { merge: c.req.valid('query').merge });
      if (result === 'conflict') {
        return c.json({ error: 'A tag with that name already exists' }, 409);
      }
      if (result === 'missing') return c.json({ error: 'Not found' }, 404);
      return c.json(result);
    },
  )

  /** Removes the tag from every note that carries it. The notes stay. */
  .delete('/tags/:id', async (c) => {
    const ok = await c.get('notes').deleteTag(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });
