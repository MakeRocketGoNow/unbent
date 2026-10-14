import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  type AutofillUsage,
  createNoteSchema,
  duplicateNoteSchema,
  InvalidFieldValue,
  listNotesQuerySchema,
  noteBatchSchema,
  restoreRevisionSchema,
  updateNoteSchema,
  updateNotesSchema,
} from '@unbent/shared';
import { NothingToRead } from '../lib/autofill.js';
import { press } from '../lib/autofill-press.js';
import { copyAttachments } from '../lib/copy-attachments.js';
import { StorageFull, quotaOf, storageFullBody } from '../lib/quota.js';
import { canAutofill, JevError, jevFrom } from '../lib/jev.js';
import { canUseLlm, llmFrom } from '../lib/llm.js';
import { dailyCap } from '../lib/llm-usage.js';
import { isOperator } from '../lib/instance.js';
import { nextCursor } from '../lib/notes-repo.js';
import { autofillReaders } from '../lib/read-attachment.js';
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
 * A revision's id from the path: a positive integer, or null for anything else, which
 * the routes answer as they answer an id that names nothing. Checked here because the
 * value crosses RPC into a bind, and `Number('abc')` there would be a NaN in a query.
 */
function revisionIdOf(raw: string): number | null {
  // Fifteen digits: every such number is a safe integer, which sixteen are not.
  if (!/^[1-9]\d{0,14}$/.test(raw)) return null;
  return Number(raw);
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
      exact,
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

    // One call to the store for both. Only counted on the first page: a paging client
    // already knows the total, and the count is the expensive half.
    const { items, total } = await repo.listPage(
      { limit, cursor, tags, notebook, fields, trashed, sort, order, from, to, ...bySort },
      cursor ? null : { ...filter, exact },
    );

    // The cursor is derived from the sort that produced the page, so the two cannot
    // disagree; see `nextCursor`.
    return c.json({
      items,
      cursor: nextCursor(items, { limit, sort, trashed, ...bySort }),
      total,
    });
  })

  /**
   * 201 with the note, or 200 with the note that already holds the id the client chose
   * — a replay of a request whose answer was lost, which must not make a second note.
   */
  .post('/notes', zValidator('json', createNoteSchema), async (c) => {
    const { id, ...input } = c.req.valid('json');
    try {
      const { note, existing } = await c.get('notes').createOrFind({ id: id ?? crypto.randomUUID(), ...input });
      return c.json(note, existing ? 200 : 201);
    } catch (err) {
      if (err instanceof InvalidFieldValue) return c.json({ error: fieldError(err) }, 400);
      throw err;
    }
  })

  /**
   * A trashed note is served too, carrying `deletedAt`: the trash opens one read-only so
   * it can be looked at before it is restored or destroyed. Every write still refuses it.
   */
  .get('/notes/:id', async (c) => {
    const note = await c.get('notes').get(c.req.param('id'), { includeTrashed: true });
    if (!note) return c.json({ error: 'Not found' }, 404);
    return c.json(note);
  })

  /**
   * A patch carrying `ifUpdatedAt` for a note saved since is a 409, with the note as it now
   * stands under `stale` so the client can show both sides without reading it again.
   */
  .patch('/notes/:id', zValidator('json', updateNoteSchema), async (c) => {
    try {
      const note = await c.get('notes').update(c.req.param('id'), c.req.valid('json'));
      if (!note) return c.json({ error: 'Not found' }, 404);
      if ('stale' in note) {
        return c.json({ error: 'This note changed after the copy this save was made from', stale: note.stale }, 409);
      }
      return c.json(note);
    } catch (err) {
      if (err instanceof InvalidFieldValue) return c.json({ error: fieldError(err) }, 400);
      throw err;
    }
  })

  /**
   * The note's history: the copies kept of what a write replaced, newest first, without
   * their bodies. Read from the server each time and never part of the change feed — a
   * safety net asked for rarely, not data every device should hold. A trashed note has
   * none to show; it is restored first.
   */
  .get('/notes/:id/revisions', async (c) => {
    const revisions = await c.get('notes').listRevisions(c.req.param('id'));
    if (!revisions) return c.json({ error: 'Not found' }, 404);
    return c.json({ revisions });
  })

  /**
   * Clears the note's history: every copy, for good. The note itself is not changed.
   * The one destructive route here that needs no trip through the trash first, because
   * what it destroys is the safety net and not the thing it protects; the client asks
   * before calling it.
   */
  .delete('/notes/:id/revisions', async (c) => {
    const cleared = await c.get('notes').clearRevisions(c.req.param('id'));
    if (cleared === null) return c.json({ error: 'Not found' }, 404);
    return c.json({ cleared });
  })

  .get('/notes/:id/revisions/:revision', async (c) => {
    const revisionId = revisionIdOf(c.req.param('revision'));
    const revision = revisionId === null ? null : await c.get('notes').getRevision(c.req.param('id'), revisionId);
    if (!revision) return c.json({ error: 'Not found' }, 404);
    return c.json(revision);
  })

  /**
   * Puts a copy back — its title and body, and its notebook, tags and field values when
   * it holds them — and answers `{ note, kept }`: the note as it now stands, and the id
   * of the copy kept of what was replaced, so this is undone the same way it was done.
   * `kept` is null when the copy was already what the note said and nothing was written.
   * `skipped`, when present, names what the copy holds that no longer fits and was left
   * as the note has it; that is a 200 like any other, never a refusal.
   *
   * The body is optional, read by hand as the duplicate route reads its own. With
   * `ifUpdatedAt`, a note saved since is a 409 carrying it under `stale`, as a patch's is.
   */
  .post('/notes/:id/revisions/:revision/restore', async (c) => {
    const revisionId = revisionIdOf(c.req.param('revision'));
    const body = restoreRevisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'ifUpdatedAt must be a timestamp' }, 400);
    const restored =
      revisionId === null
        ? null
        : await c.get('notes').restoreRevision(c.req.param('id'), revisionId, body.data.ifUpdatedAt);
    if (!restored) return c.json({ error: 'Not found' }, 404);
    if ('stale' in restored) {
      return c.json({ error: 'This note changed after the copy this restore was made from', stale: restored.stale }, 409);
    }
    return c.json(restored);
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
    // The body is optional — the copy's id, chosen by the client for the reason
    // `createNoteSchema.id` gives — so it is read by hand rather than required.
    const body = duplicateNoteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'The copy\'s id must be a UUID' }, 400);
    const copy = await notes.duplicateOrFind(id, body.data.id ?? crypto.randomUUID());
    if (!copy) return c.json({ error: 'Not found' }, 404);
    const { note, existing } = copy;

    // On a replay, copy only what the first attempt did not reach. A lost answer is often
    // a Worker that died partway through the copy, after the note itself was committed,
    // and a replay that returned the note as it stood would leave it short of files for
    // good. Comparing by filename: a copy keeps its source's names. `skipExisting` is
    // for the replay that arrives while the first request is still copying: both see
    // the same file missing, and the store lets one of them record it.
    const files = await attachments.listForNote(id);
    const have = existing ? new Set((await attachments.listForNote(note.id)).map((f) => f.filename)) : new Set<string>();
    const missing = files.map((f) => f.filename).filter((f) => !have.has(f));
    if (missing.length > 0) {
      try {
        await copyAttachments(c.env.BLOBS, { attachments, notes }, { from: id, to: note.id, filenames: missing, skipExisting: true, quota: quotaOf(c.env, c.get('plan')) });
      } catch (err) {
        // The copy of the note stands, without the files it had no room for: a note with
        // no files is still the note. Answered as the success it is, with `filesSkipped`
        // saying why the files are missing — a 4xx would have the outbox take the copy
        // back as if nothing had been written, and the next pull bring it again.
        if (err instanceof StorageFull) return c.json({ ...note, filesSkipped: storageFullBody(err) }, existing ? 200 : 201);
        throw err;
      }
    }
    return c.json(note, existing ? 200 : 201);
  })

  /**
   * What the model would file this note as: a title, a notebook, tags and field values,
   * each with its confidence. Suggestions only — nothing in the note is written; see
   * `AutofillSuggestion` for why the client applies them. What is written is the press
   * itself and what the model cost, to the account's usage counter, and a press past the
   * day's cap (`AUTOFILL_DAILY_CAP`) is a 429 with a sentence the button shows; see
   * `press` in lib/autofill-press.ts.
   *
   * A POST, because it is not free: every call is a round trip to a paid API, and nothing
   * that treats GET as safe — a prefetch, a cache, a retry — may make one on its own.
   * Ownership is checked before configuration, so the 404 for another user's note holds
   * on an instance with no key too.
   */
  .post('/notes/:id/autofill', async (c) => {
    try {
      const outcome = await press(
        {
          notes: c.get('notes'),
          attachments: c.get('attachments'),
          blobs: c.env.BLOBS,
          readers: autofillReaders(c.env),
          jev: canAutofill(c.env) ? jevFrom(c.env) : null,
          llm: canUseLlm(c.env) ? llmFrom(c.env) : undefined,
          cap: dailyCap(c.env),
          operator: isOperator(c.env, c.get('user')?.email),
          defer: (work) => c.executionCtx.waitUntil(work),
        },
        c.req.param('id'),
      );
      switch (outcome.kind) {
        case 'missing':
          return c.json({ error: 'Not found' }, 404);
        case 'unconfigured':
          return c.json({ error: 'Auto-fill is not set up on this instance' }, 503);
        case 'capped':
          // The sentence is the button's; Retry-After is for anything that reads headers.
          c.header('Retry-After', String(outcome.retryAfter));
          return c.json({ error: outcome.message }, 429);
        case 'filed':
          return c.json(outcome.suggestion);
      }
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

  /**
   * The account's Auto-fill this calendar year: presses, today's, the cap, and the
   * model's tokens by job and model (`AutofillUsage`). One store call. Shown on
   * Maintenance until the plans decide where it lives (MAK-108).
   */
  .get('/autofill/usage', requireAuth, withRepos, async (c) => {
    const usage: AutofillUsage = { ...(await c.get('notes').autofillUsage()), dailyCap: dailyCap(c.env) };
    return c.json(usage);
  })

  /** Restores a trashed note. 404 when it is not this user's, or was never trashed. */
  .post('/notes/:id/restore', async (c) => {
    const ok = await c.get('notes').restore(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    const note = await c.get('notes').get(c.req.param('id'));
    return c.json(note);
  })

  /**
   * Permanently deletes one trashed note.
   *
   * Only ever acts on a note already in the trash, so a stray call cannot destroy live
   * work — the two-step delete is the safety property, not the confirmation dialog.
   *
   * Its files are not deleted here. The store tombstones their keys in the transaction
   * that removes the rows, and the hourly sweep deletes the objects thirty-five days on
   * (`DeletedBlobs`), so an operator winding the store back finds them still there. This
   * route used to delete them at once, and a restored note then pointed at nothing.
   */
  .delete('/notes/:id/permanent', async (c) => {
    const { deleted } = await c.get('notes').purgeOne(c.req.param('id'));
    if (!deleted) return c.json({ error: 'Not found' }, 404);
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

  /** The files follow the store, as for `/notes/:id/permanent`: tombstoned, not deleted. */
  .post('/notes/purge', zValidator('json', noteBatchSchema), async (c) => {
    const { deleted } = await c.get('notes').purgeMany(c.req.valid('json').ids);
    return c.json({ deleted });
  })

  .get('/tags', requireAuth, withRepos, async (c) => {
    return c.json({ tags: await c.get('notes').listTags() });
  })
;
