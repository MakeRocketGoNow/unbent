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
    const { cursor, limit, tag } = c.req.valid('query');
    const items = await c.get('notes').list({ limit, cursor, tag });

    // Keyset cursor: the oldest updated_at in this page. Only offered on a full page.
    const next = items.length === limit ? String(items[items.length - 1]?.updatedAt) : null;
    return c.json({ items, cursor: next });
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

  .get('/tags', requireAuth, withRepos, async (c) => {
    return c.json({ tags: await c.get('notes').listTags() });
  });
