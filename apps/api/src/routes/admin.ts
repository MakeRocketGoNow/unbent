import { Hono } from 'hono';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { deleteKeys } from '../lib/blobs.js';
import { userPrefix } from '../lib/repo.js';
import type { AppEnv } from '../types.js';

/**
 * Destructive maintenance, all scoped to the caller's own data.
 *
 * Every route here enumerates or deletes under `users/{me}/` and filters D1 by the session
 * user, so none of them can see or touch another account. An operator-wide sweep would
 * need separate, deliberately privileged handling.
 */
export const admin = new Hono<AppEnv>()
  /**
   * Deletes R2 objects with no attachment row pointing at them.
   *
   * R2 has no foreign keys, so objects outlive their metadata when a crash lands between
   * BLOBS.put and the metadata insert, or when a user row cascades away its attachment
   * rows without its prefix having been swept — account deletion sweeps first, so what is
   * left here is a row removed by hand or by a test fixture. Neither is reachable through
   * the app, so only a sweep reclaims the storage.
   *
   * Dry run by default; `?apply=1` deletes.
   */
  .post('/admin/gc-blobs', requireAuth, async (c) => {
    const userId = c.get('userId')!;
    const apply = c.req.query('apply') === '1';
    const prefix = userPrefix(userId);

    const { results } = await c.env.DB.prepare(
      `SELECT r2_key FROM attachments WHERE user_id = ?1`,
    )
      .bind(userId)
      .all<{ r2_key: string }>();
    const referenced = new Set(results.map((r) => r.r2_key));

    const orphans: string[] = [];
    let stored = 0;
    let cursor: string | undefined;

    // Paginate: a large account holds far more objects than one list() returns.
    for (;;) {
      const page = await c.env.BLOBS.list({ prefix, cursor, limit: 1000 });
      stored += page.objects.length;
      for (const obj of page.objects) {
        if (!referenced.has(obj.key)) orphans.push(obj.key);
      }
      if (!page.truncated) break;
      cursor = page.cursor;
    }

    if (apply) await deleteKeys(c.env.BLOBS, orphans);

    return c.json({
      referenced: referenced.size,
      stored,
      orphaned: orphans.length,
      deleted: apply ? orphans.length : 0,
      dryRun: !apply,
      keys: orphans.slice(0, 50),
    });
  })

  /**
   * Permanently deletes notes and their attachments.
   *
   * `?scope=trashed` (default) empties the trash — the storage that soft delete leaves
   * behind. `?scope=all` wipes every note in the account, which is what makes a trial
   * import repeatable. Each call takes a page and answers with `remaining`.
   *
   * Irreversible, so it requires `?confirm=DELETE` rather than firing on a bare POST: a
   * mistyped URL or a stray retry should not be able to empty an account.
   */
  .post('/admin/purge-notes', requireAuth, withRepos, async (c) => {
    const scope = c.req.query('scope') === 'all' ? 'all' : 'trashed';

    if (c.req.query('confirm') !== 'DELETE') {
      return c.json(
        {
          error: 'Confirmation required',
          hint: `Repeat this request with &confirm=DELETE to permanently delete ${
            scope === 'all' ? 'every note in this account' : 'all trashed notes'
          }.`,
        },
        400,
      );
    }

    // A page of the scope per call, and how much is left; the client calls until that
    // is zero. See `NotesRepo.purge` for why one call cannot do it all.
    const { notes, keys, remaining } = await c.get('notes').purge(scope);

    // Blobs go after the rows: a failure here leaves orphans the sweep can reclaim, while
    // the reverse would leave notes pointing at objects that no longer exist.
    await deleteKeys(c.env.BLOBS, keys);

    return c.json({ scope, notesDeleted: notes, filesDeleted: keys.length, remaining });
  })

  /**
   * Counts the notes in every notebook and tag again, and the account's totals, and
   * corrects any stored count that disagrees. Answers with how many did.
   *
   * Not destructive, unlike its neighbours: the counts are derived, so the worst a recount
   * can do is replace a wrong number with the right one. It lives here because it is the
   * same kind of operation — over the whole account, run by hand from Maintenance.
   */
  .post('/admin/recount-notes', requireAuth, withRepos, async (c) => {
    return c.json({ corrected: await c.get('notes').recountNotes() });
  });
