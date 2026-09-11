import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { tagNameSchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * Tag management: rename and delete.
 *
 * Tags had no management surface at all — they existed only as a side effect of the
 * notes that carried them, and the only way to fix a misspelt tag across three hundred
 * notes was to open three hundred notes. Listing stays on the notes routes, where it has
 * always been; these two are the mutations, addressed by id like a notebook's, since an
 * id is stable across the rename that is the whole point.
 *
 * A tag that is not this user's is a 404 rather than a 403, matching every other route:
 * confirming an id exists is itself a leak.
 */
const nameBody = z.object({ name: tagNameSchema });

export const tags = new Hono<AppEnv>()
  .use('/tags/*', requireAuth, withRepos)

  /**
   * Renames a tag. 409 when another tag already has the name, unless `?merge=1`, which
   * folds this tag into that one — the client confirms first, because it cannot be undone.
   */
  .patch(
    '/tags/:id',
    zValidator('json', nameBody),
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
      const result = await c
        .get('notes')
        .renameTag(c.req.param('id'), c.req.valid('json').name, {
          merge: c.req.valid('query').merge,
        });
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
