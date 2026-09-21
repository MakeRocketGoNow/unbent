import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  createNoteSchema,
  InvalidFieldValue,
  listNotesQuerySchema,
  noteBatchSchema,
  updateNoteSchema,
  updateNotesSchema,
} from '@unbent/shared';
import { isExtractable } from '@unbent/enex/ocr-text';
import { autofill, EXAMPLES_PER_OPTION, NothingToRead } from '../lib/autofill.js';
import { copyAttachments } from '../lib/copy-attachments.js';
import { canAutofill, JevError, jevFrom } from '../lib/jev.js';
import { nextCursor } from '../lib/notes-repo.js';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * A custom-field value the field cannot hold is the client's mistake, so it is a 400 that
 * names the field — "Amount must be a number" — rather than a 500 that names nothing.
 * Validation of the *shape* is zod's job at the route; whether a value fits its field's
 * type is only known once the definition is read, which is why it surfaces from the repo.
 */
function fieldError(err: InvalidFieldValue): string {
  return `${err.fieldName} ${err.message}`;
}

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
    const {
      cursor,
      limit,
      tag: tags,
      notebook,
      field: fields,
      trashed,
      sort,
      order,
      from,
      to,
      sortField: sortFieldId,
    } = c.req.valid('query');
    const repo = c.get('notes');
    /*
     * A field sort is built from the definition, so it is looked up here, once, and
     * shared by the list, the count and the cursor. An id that is not this user's reads
     * as missing, the way a value write to one does — never a 403 that confirms it exists.
     */
    const sortField = sortFieldId ? await repo.fieldById(sortFieldId) : null;
    if (sortFieldId && !sortField) return c.json({ error: 'No such field' }, 400);
    const bySort = sortField ? { sortField } : {};
    // The count has to see the same range as the list, or the header contradicts the rows.
    const filter = { tags, notebook, fields, trashed, from, to, sort, ...bySort };

    const [items, total] = await Promise.all([
      repo.list({ limit, cursor, tags, notebook, fields, trashed, sort, order, from, to, ...bySort }),
      // Only counted on the first page: a paging client already knows the total, and this
      // is a second query on a hot path.
      cursor ? Promise.resolve<number | null>(null) : repo.count(filter),
    ]);

    // The cursor is derived from the sort that produced the page, so the two cannot
    // disagree; see `nextCursor`.
    return c.json({
      items,
      cursor: nextCursor(items, { limit, sort, trashed, ...bySort }),
      total,
    });
  })

  .post('/notes', zValidator('json', createNoteSchema), async (c) => {
    const input = c.req.valid('json');
    try {
      const note = await c.get('notes').create({ id: crypto.randomUUID(), ...input });
      return c.json(note, 201);
    } catch (err) {
      if (err instanceof InvalidFieldValue) return c.json({ error: fieldError(err) }, 400);
      throw err;
    }
  })

  .get('/notes/:id', async (c) => {
    const note = await c.get('notes').get(c.req.param('id'));
    if (!note) return c.json({ error: 'Not found' }, 404);
    return c.json(note);
  })

  .patch('/notes/:id', zValidator('json', updateNoteSchema), async (c) => {
    try {
      const note = await c.get('notes').update(c.req.param('id'), c.req.valid('json'));
      if (!note) return c.json({ error: 'Not found' }, 404);
      return c.json(note);
    } catch (err) {
      if (err instanceof InvalidFieldValue) return c.json({ error: fieldError(err) }, 400);
      throw err;
    }
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

  /**
   * A copy of the note, files and all, opened by the client as its own note.
   *
   * The Evernote habit this serves is a note used as a template — a packing list, a
   * checklist for a recurring job. The files come across as copies, never shared, for
   * the reasons `copyAttachments` gives; every file is copied, linked or not, the same
   * way the export includes them, so nothing the note held is lost in the duplicate.
   */
  .post('/notes/:id/duplicate', async (c) => {
    const id = c.req.param('id');
    const notes = c.get('notes');
    const attachments = c.get('attachments');
    const copy = await notes.duplicate(id, crypto.randomUUID());
    if (!copy) return c.json({ error: 'Not found' }, 404);

    const files = await attachments.listForNote(id);
    if (files.length > 0) {
      await copyAttachments(
        c.env.BLOBS,
        { attachments, notes },
        { from: id, to: copy.id, filenames: files.map((f) => f.filename) },
      );
    }
    return c.json(copy, 201);
  })

  /**
   * What the model would file this note as: a title, a notebook, tags and field values,
   * each with its confidence. Suggestions only — nothing is written; see
   * `AutofillSuggestion` for why the client applies them.
   *
   * A POST although it changes nothing here, because it is not free: every call is a
   * round trip to a paid API, and nothing that treats GET as safe — a prefetch, a cache, a
   * retry — may make one on its own. Ownership is checked before configuration, so the
   * 404 for another user's note holds on an instance with no key too.
   */
  .post('/notes/:id/autofill', async (c) => {
    const id = c.req.param('id');
    const notes = c.get('notes');
    const attachments = c.get('attachments');

    const note = await notes.get(id);
    if (!note) return c.json({ error: 'Not found' }, 404);
    if (!canAutofill(c.env)) return c.json({ error: 'Auto-fill is not set up on this instance' }, 503);

    const [files, notebooks, fields, tags, examples] = await Promise.all([
      attachments.textsForNote(id),
      notes.listNotebooks(),
      notes.listAllFields(),
      notes.listTags(),
      notes.sampleTitles(id, EXAMPLES_PER_OPTION),
    ]);

    try {
      const suggestion = await autofill(jevFrom(c.env), {
        note: { title: note.title, body: note.body, tags: note.tags, notebookId: note.notebookId ?? null },
        // Only a PDF is ever read, so a photograph with no text is "nothing there" rather
        // than "still being read" — see `textsForNote`.
        attachments: files.map((f) => ({
          filename: f.filename,
          text: isExtractable(f.contentType) ? f.text : '',
        })),
        notebooks: notebooks.map((nb) => ({
          id: nb.id,
          name: nb.name,
          fields: fields.filter((f) => f.notebookId === nb.id),
          examples: examples.notebooks.get(nb.id) ?? [],
        })),
        tags: tags.map((t) => ({ name: t.name, examples: examples.tags.get(t.id) ?? [] })),
      });
      return c.json(suggestion);
    } catch (err) {
      if (err instanceof NothingToRead) return c.json({ error: err.message }, 422);
      if (err instanceof JevError) {
        // The upstream failure, with its reason, rather than an anonymous 500: the reason
        // is what tells an invalid key from an outage, and both are the operator's to fix.
        console.error('autofill:', err.message);
        return c.json({ error: err.message }, 502);
      }
      throw err;
    }
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

  /*
     Several notes at once — the list's selection.

     Each is the singular route above over a set of ids, answered with a count rather than
     the notes: the client already holds the rows it named and refetches the list anyway,
     and five hundred notes with their fields is a page nobody asked for. An id that is not
     this user's, or is on the wrong side of the trash, is left out of the count rather
     than failing the request — see the repo's batch methods for why.

     `PATCH /notes` rather than a `/notes/batch`: it is the collection being patched, and
     the ids are the body's business. The three verbs are POSTs with a body for the same
     reason — a DELETE carrying JSON is legal and widely mishandled.
  */

  .patch('/notes', zValidator('json', updateNotesSchema), async (c) => {
    const { ids, ...patch } = c.req.valid('json');
    const { matched, changed } = await c.get('notes').updateMany(ids, patch);
    return c.json({ matched: matched.length, changed: changed.length });
  })

  .post('/notes/trash', zValidator('json', noteBatchSchema), async (c) => {
    const trashed = await c.get('notes').removeMany(c.req.valid('json').ids);
    return c.json({ trashed: trashed.length });
  })

  .post('/notes/restore', zValidator('json', noteBatchSchema), async (c) => {
    const restored = await c.get('notes').restoreMany(c.req.valid('json').ids);
    return c.json({ restored: restored.length });
  })

  /**
   * Blobs after rows, for the reason `/notes/:id/permanent` gives. `purgeMany` only
   * returns keys of notes it actually deleted, so a restore that won the race does not
   * come back as a live note whose files are already gone.
   */
  .post('/notes/purge', zValidator('json', noteBatchSchema), async (c) => {
    const { deleted, keys } = await c.get('notes').purgeMany(c.req.valid('json').ids);
    for (const key of keys) await c.env.BLOBS.delete(key);
    return c.json({ deleted });
  })

  .get('/tags', requireAuth, withRepos, async (c) => {
    return c.json({ tags: await c.get('notes').listTags() });
  })
;
