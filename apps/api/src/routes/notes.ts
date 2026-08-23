import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  createNoteSchema,
  listNotesQuerySchema,
  updateNoteSchema,
} from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * Note CRUD. Every handler reads its repo from context rather than touching env.DB, so
 * scoping is structural (see lib/repos-middleware.ts).
 *
 * A note that does not exist and a note belonging to someone else both return 404 — never
 * 403, which would confirm the id exists.
 */
export const notes = new Hono<AppEnv>()
  .use('/notes/*', requireAuth, withRepos)
  .use('/notes', requireAuth, withRepos)

  .get('/notes', zValidator('query', listNotesQuerySchema), async (c) => {
    const { cursor, limit, tag, notebook, trashed } = c.req.valid('query');
    const repo = c.get('notes');
    const filter = { tag, notebook, trashed };

    const [items, total] = await Promise.all([
      repo.list({ limit, cursor, tag, notebook, trashed }),
      // Only counted on the first page: a paging client already knows the total, and this
      // is a second query on a hot path.
      cursor ? Promise.resolve<number | null>(null) : repo.count(filter),
    ]);

    /**
     * Keyset cursor: the last row's sort key. Only offered on a full page.
     *
     * The trash is ordered by `deleted_at`, so it must page on that column — using
     * `updated_at` there would skip or repeat notes.
     */
    const lastRow = items[items.length - 1];
    const next =
      items.length === limit && lastRow
        ? String(trashed ? (lastRow.deletedAt ?? lastRow.updatedAt) : lastRow.updatedAt)
        : null;
    return c.json({ items, cursor: next, total });
  })

  .post('/notes', zValidator('json', createNoteSchema), async (c) => {
    const input = c.req.valid('json');
    const note = await c.get('notes').create({ id: crypto.randomUUID(), ...input });
    return c.json(note, 201);
  })

  .get('/notes/:id', async (c) => {
    const note = await c.get('notes').get(c.req.param('id'));
    if (!note) return c.json({ error: 'Not found' }, 404);
    return c.json(note);
  })

  .patch('/notes/:id', zValidator('json', updateNoteSchema), async (c) => {
    const note = await c.get('notes').update(c.req.param('id'), c.req.valid('json'));
    if (!note) return c.json({ error: 'Not found' }, 404);
    return c.json(note);
  })

  /**
   * Soft delete — trash, not destroy. Attachments are deliberately left in R2: this note
   * is restorable, and deleting its blobs here would make a restore produce a note full of
   * dead links. Reclaiming that storage belongs to a purge of the trash, which does not
   * exist yet; see the orphaned-blob note in README.
   */
  .delete('/notes/:id', async (c) => {
    const ok = await c.get('notes').remove(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  })

  /** Restores a trashed note. 404 when it is not this user's, or was never trashed. */
  .post('/notes/:id/restore', async (c) => {
    const ok = await c.get('notes').restore(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    const note = await c.get('notes').get(c.req.param('id'));
    return c.json(note);
  })

  /**
   * Permanently deletes one trashed note and its blobs.
   *
   * Only ever acts on a note already in the trash, so a stray call cannot destroy live
   * work — the two-step delete is the safety property, not the confirmation dialog.
   */
  .delete('/notes/:id/permanent', async (c) => {
    const { deleted, keys } = await c.get('notes').purgeOne(c.req.param('id'));
    if (!deleted) return c.json({ error: 'Not found' }, 404);

    // Blobs after rows: a failure here leaves orphans the sweep reclaims, while the
    // reverse would leave a note pointing at objects that no longer exist.
    for (const key of keys) await c.env.BLOBS.delete(key);

    return c.body(null, 204);
  })

  .get('/tags', requireAuth, withRepos, async (c) => {
    return c.json({ tags: await c.get('notes').listTags() });
  })
;
