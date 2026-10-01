import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createFieldSchema,
  fieldScaleSchema,
  fieldTypeSchema,
  notebookEmojiSchema,
  notebookNameSchema,
  notebookPurposeSchema,
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

/**
 * A PATCH may change the name, the purpose, the emoji, or any mix, so each is optional — but
 * an empty body changes nothing, and that is a stale client, not a request. `purpose` and
 * `emoji` accept `null` to clear them; an absent key leaves that column untouched (see
 * `updateNotebook`).
 */
const updateBody = z
  .object({
    name: notebookNameSchema.optional(),
    purpose: notebookPurposeSchema.optional(),
    emoji: notebookEmojiSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.purpose !== undefined || b.emoji !== undefined, {
    message: 'Nothing to update',
  });

export const notebooks = new Hono<AppEnv>()
  .use('/notebooks', requireAuth, withRepos)
  .use('/notebooks/*', requireAuth, withRepos)

  /**
   * `unfiled` rides along because notes in no notebook have no row to be counted in, and
   * the scope selector hides its "Unfiled" option when that count is zero.
   */
  .get('/notebooks', async (c) => {
    const { notebooks, unfiled } = await c.get('notes').notebooksOverview();
    return c.json({ notebooks, unfiled });
  })

  /** Creates an empty notebook. 409 when the name is taken, case-insensitively. */
  .post('/notebooks', zValidator('json', nameBody), async (c) => {
    const created = await c.get('notes').createNotebook(c.req.valid('json').name);
    if (!created) return c.json({ error: 'A notebook with that name already exists' }, 409);
    return c.json(created, 201);
  })

  .patch('/notebooks/:id', zValidator('json', updateBody), async (c) => {
    const patch = c.req.valid('json');
    const result = await c.get('notes').updateNotebook(c.req.param('id'), patch);

    if (result === 'conflict') {
      return c.json({ error: 'A notebook with that name already exists' }, 409);
    }
    if (result === 'missing') return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
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

  // `?counts=1` adds each field's value count, for the page that shows it; see listFields.
  .get('/notebooks/:id/fields', async (c) => {
    const counts = c.req.query('counts') === '1';
    const fields = await c.get('notes').listFields(c.req.param('id'), { counts });
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

  /**
   * What a type change — or a re-scale — would clear, so the client can say so first.
   *
   * `scale` is `max:step`, or empty for a rating becoming a plain number. Omitting it
   * means the field keeps whatever scale it has, which is what a pure type change wants:
   * the repo reads an absent scale as "unchanged" rather than as "none".
   */
  .get(
    '/notebooks/:id/fields/:fieldId/conversion',
    zValidator(
      'query',
      z.object({
        type: fieldTypeSchema,
        scale: z
          .string()
          .optional()
          .transform((raw, ctx) => {
            if (raw === undefined) return undefined;
            if (raw === '') return null;
            const [max, step] = raw.split(':').map(Number);
            const parsed = fieldScaleSchema.safeParse({ max, step });
            if (!parsed.success) {
              ctx.addIssue({ code: 'custom', message: 'scale must be max:step' });
              return undefined;
            }
            return parsed.data;
          }),
      }),
    ),
    async (c) => {
      const { type, scale } = c.req.valid('query');
      const preview = await c
        .get('notes')
        .previewConversion(c.req.param('id'), c.req.param('fieldId'), type, scale);
      if (!preview) return c.json({ error: 'Not found' }, 404);
      return c.json(preview);
    },
  )

  /**
   * How many notes still hold a given select or multi-select option, so removing it can
   * name that number before deciding what becomes of them.
   *
   * The option rides in a query param rather than the path: an option is free text and
   * can hold a slash or an ampersand, which a path segment would split or a proxy rewrite.
   * A field that is not one with options, or an id that is not this user's, is a 404 — the
   * same "no such thing" as elsewhere, told apart from "an option no note uses", which is
   * a `0` count.
   */
  .get(
    '/notebooks/:id/fields/:fieldId/option-usage',
    zValidator('query', z.object({ option: z.string().min(1) })),
    async (c) => {
      const notes = await c
        .get('notes')
        .countOptionUsage(c.req.param('id'), c.req.param('fieldId'), c.req.valid('query').option);
      if (notes === null) return c.json({ error: 'Not found' }, 404);
      return c.json({ notes });
    },
  )

  /**
   * Removes one option from a select or multi-select.
   *
   * `?clear=1` also takes the option off every note that held it — the deliberate cleanup
   * the client confirms by name and count. Without it, the option leaves the list and the
   * notes keep their value, shown as "(no longer an option)": the default, because
   * removing an option is usually a reorganisation, not a decision to erase data.
   *
   * Returns the updated field and how many notes were cleared (`0` unless `clear`). A 404
   * covers both a missing field and an option the field does not have, so a stale client
   * cannot report a cleanup that never ran.
   */
  .delete(
    '/notebooks/:id/fields/:fieldId/option',
    zValidator(
      'query',
      z.object({
        option: z.string().min(1),
        clear: z
          .string()
          .optional()
          .transform((v) => v === '1'),
      }),
    ),
    async (c) => {
      const { option, clear } = c.req.valid('query');
      const result = await c
        .get('notes')
        .removeFieldOption(c.req.param('id'), c.req.param('fieldId'), option, clear);
      if (!result) return c.json({ error: 'Not found' }, 404);
      return c.json(result);
    },
  )

  /** Deletes a field and every value held under it. Not recoverable; the client confirms. */
  .delete('/notebooks/:id/fields/:fieldId', async (c) => {
    const ok = await c.get('notes').deleteField(c.req.param('id'), c.req.param('fieldId'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });
