import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { deleteKeys } from '../lib/blobs.js';
import { clearRestore, directoryRow, dropDirectoryRow, listOperatorAccounts, OPERATOR_PAGE_MAX, operatorAccount as readOperatorAccount, recordRestore } from '../lib/directory.js';
import { beginDump } from '../lib/dump.js';
import { MIRROR_STATUS_KEY, STATUS_KEY, dumpPrefix } from '../lib/backups.js';
import { beforeLoadKey, describeDump, dumpBeforeLoad, loadReserve, resolveDumpDownload, resolveDumpKey, streamDump } from '../lib/load.js';
import { isOperator } from '../lib/instance.js';
import { userPrefix } from '../lib/repo.js';
import { storeFor } from '../lib/store-client.js';
import { sweepStores } from '../lib/sweep.js';
import { SWEEP_TOKEN_HEADER, sweepTokenMatches } from '../lib/sweep-token.js';
import { BOOKMARK_PATTERN, RESTORE_WINDOW_MS, isRestoreUnsupported, readRestoreAbort, readRestoreRefusal } from '../store/restore.js';
import type { StoreStats } from '../store/user-store.js';
import type { AccountDumps, BackupsStatus, DumpStatus, MirrorStatus } from '@unbent/shared';
import type { AppEnv } from '../types.js';

/**
 * The deploy job's way into the sweep. Passes a request without the header on to the
 * session checks; answers one with it, either by sweeping or with the same 404 a
 * non-operator gets.
 */
const sweepByToken = createMiddleware<AppEnv>(async (c, next) => {
  const presented = c.req.header(SWEEP_TOKEN_HEADER);
  if (presented === undefined) return next();
  if (!(await sweepTokenMatches(c.env, presented))) return c.json({ error: 'Not found' }, 404);
  console.log('[store] token sweep');
  return c.json(await sweepStores(c.env, { restart: c.req.query('restart') === '1' }));
});

/**
 * Destructive maintenance, all scoped to the caller's own data.
 *
 * Every route here enumerates or deletes under `users/{me}/` and reads the session user's
 * own note store, so none of them can see or touch another account. An operator-wide sweep would
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
  .post('/admin/gc-blobs', requireAuth, withRepos, async (c) => {
    // A preview with stores of its own still shares the dev instance's bucket, where this
    // account's files are referenced by dev's store and not by this one. Every one of them
    // would read as an orphan here, and `?apply=1` would delete the lot from dev.
    if (c.env.PREVIEW_OWN_STORES === '1') {
      return c.json({ error: 'Not on a preview with stores of its own: the files belong to the dev instance.' }, 409);
    }
    const userId = c.get('userId')!;
    const apply = c.req.query('apply') === '1';
    const prefix = userPrefix(userId);

    // Every key the account's rows reference, a page at a time from the store: an
    // archive references thousands and an RPC result has a ceiling.
    const referenced = new Set<string>();
    for (let after = 0; ; ) {
      const page = await c.get('attachments').blobKeys(after, 1000);
      for (const key of page.keys) referenced.add(key);
      if (page.nextRowid === null) break;
      after = page.nextRowid;
    }
    // And every key of a file deleted in the last thirty-five days, which the store is
    // keeping in R2 for a restore to find (`DeletedBlobs`). Referenced for this purpose:
    // the hourly sweep deletes those on their day, and a sweep here that took them early
    // would undo the one thing the tombstones are for.
    let awaitingDeletion = 0;
    for (let after = ''; ; ) {
      const page = await c.get('attachments').tombstonedBlobKeys(after, 1000);
      for (const key of page.keys) referenced.add(key);
      awaitingDeletion += page.keys.length;
      if (page.next === null) break;
      after = page.next;
    }

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
      awaitingDeletion,
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
    // is zero. See `NotesRepo.purge` for why one call cannot do it all. The files are
    // not deleted here: the store tombstoned their keys with the rows, and the hourly
    // sweep deletes the objects thirty-five days on (`DeletedBlobs`), so this account
    // can still be wound back to before the purge with its files.
    const { notes, keys, remaining } = await c.get('notes').purge(scope);

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
  })

  /**
   * Removes the accounts the test suites create, with their note stores.
   *
   * The live suites sign up throwaway `@example.test` actors, and `pnpm test` purges them
   * afterwards. That used to be one SQL statement against local D1 — delete the user rows
   * and let the cascade take the notes — but the notes are in objects now, and nothing but
   * the Worker can reach one. So the purge is a route: wipe each actor's store, then delete
   * the user row, whose cascade takes the sessions, and drop the directory row.
   *
   * Local only, in the one way this codebase already draws that line: `ALLOW_TEST_CREDENTIALS`
   * is passed by `pnpm dev` on the command line and cannot be copied into a deployed
   * Worker, and the route answers 404 without it. No session, because the suites' actors
   * are the ones being deleted; the address pattern is the whole scope, and no real account
   * has one.
   */
  .post('/admin/test/purge-fixtures', async (c) => {
    if (c.env.ALLOW_TEST_CREDENTIALS !== '1') return c.json({ error: 'Not found' }, 404);
    const { results } = await c.env.DB.prepare(`SELECT id FROM user WHERE email LIKE '%@example.test'`).all<{ id: string }>();
    let wiped = 0;
    const failed: string[] = [];
    for (const { id } of results) {
      try {
        await storeFor(c.env, id).wipe();
        wiped += 1;
      } catch (err) {
        // The row goes anyway: an object left with rows behind a deleted user is caught by
        // the sweep, which treats a directory row with no user as tombstoned.
        console.error(`purge-fixtures: wipe failed for ${id}:`, err);
        failed.push(id);
        continue;
      }
      await c.env.DB.prepare(`DELETE FROM user WHERE id = ?1`).bind(id).run();
      await dropDirectoryRow(c.env.DB, id);
    }
    return c.json({ users: results.length, wiped, failed });
  })

  /*
     The operator's window into a note store. An object has no console: nothing lists its
     tables, nothing runs a query against it, nothing copies it out. These routes are that
     console, and they are what `wrangler d1 execute`, `d1 export` and Time Travel used to
     be for the shared database.

     `stats` and `dump` are the signed-in user's own by default; a session in
     OPERATOR_EMAILS may name another account with `?user=`, and every such read is logged
     with both ids, since it is one person reading another's notes and the log is the
     record of it. `sql`, `restore` and `sweep` are the operator's alone: a raw query over
     someone's notes, winding them back, and the walk over every account — which a deploy
     job may also start, with the deployment's sweep token instead of a session.
  */

  /** Row counts, size and schema version of one store. */
  .get('/admin/store/stats', requireAuth, async (c) => {
    const target = await operatorTarget(c);
    if (target instanceof Response) return target;
    return c.json(await storeFor(c.env, target).stats());
  })

  /**
   * Gives one store's change feed a new epoch, so every device holding a cursor into it
   * starts over from a snapshot. The restore route does this itself once a restore is
   * applied; this is the hand-run version for when that step failed (the answer says
   * so), or for any other reason to make every device of an account resync.
   */
  .post('/admin/store/feed-epoch', requireAuth, async (c) => {
    const target = await operatorTarget(c);
    if (target instanceof Response) return target;
    console.log(`[store] operator=${c.get('user')?.email} feed-epoch user=${target}`);
    return c.json({ user: target, ...(await storeFor(c.env, target).feedRestored()) });
  })

  /**
   * One SELECT against one store, rolled back whatever it does; see `readOnlySql`. For
   * `EXPLAIN QUERY PLAN` on a slow account as much as for looking at rows.
   */
  .post(
    '/admin/store/sql',
    requireAuth,
    zValidator('json', z.object({ query: z.string().min(1), binds: z.array(z.union([z.string(), z.number(), z.null()])).default([]), user: z.string().optional() })),
    async (c) => {
      const email = c.get('user')?.email;
      if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
      const { query, binds, user } = c.req.valid('json');
      const target = user ?? c.get('userId')!;
      // The same check `operatorTarget` makes: a store is created for any name it is
      // asked for, so an id nothing knows must be refused before it is one.
      if (target !== c.get('userId') && !(await directoryRow(c.env.DB, target))) {
        return c.json({ error: 'No such account' }, 404);
      }
      console.log(`[store] operator=${email} sql user=${target}`);
      try {
        return c.json(await storeFor(c.env, target).readOnlySql(query, binds));
      } catch (err) {
        // The query's own error — a misspelt column, a refused statement — is the answer.
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  )

  /**
   * Winds one account's store back to a moment in the last thirty days: the rollback for a
   * bad migration or a bad edit. `{ user, at }` with `at` in milliseconds or ISO 8601, or
   * `{ user, bookmark }` to restore to a bookmark this route handed out — which is how a
   * restore is undone. `user` defaults to the caller, as on `sql`.
   *
   * A dry run unless the body says `confirm: "RESTORE"`: the dry run resolves the time to
   * a bookmark, which is where a time outside the window is refused, and shows the store
   * as it is now. Dump the store before the real thing (`GET …/dump?user=`): the undo
   * bookmark covers a restore to the wrong time for thirty days, and the dump covers it
   * after that, outside the platform.
   *
   * The object restarts to apply the restore, so the call into it fails by design and the
   * reason it fails with carries the undo bookmark (see `UserStore.restoreTo`). The route
   * then reads the restored store's stats through a fresh stub, since the old one is
   * broken by the restart, and answers with both. If that read fails, the restore still
   * happened; `stats` again shows the result.
   *
   * Logged with both ids before the call, and with the undo bookmark by the object, so
   * the record exists however the request ends.
   */
  .post(
    '/admin/store/restore',
    requireAuth,
    zValidator(
      'json',
      z
        .object({
          user: z.string().optional(),
          at: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
          bookmark: z.string().regex(BOOKMARK_PATTERN).optional(),
          confirm: z.literal('RESTORE').optional(),
        })
        .refine((b) => (b.at === undefined) !== (b.bookmark === undefined), { message: 'Give exactly one of `at` or `bookmark`.' }),
    ),
    async (c) => {
      const email = c.get('user')?.email;
      if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
      const { user, at, bookmark, confirm } = c.req.valid('json');
      const target = user ?? c.get('userId')!;
      if (target !== c.get('userId')) {
        const row = await directoryRow(c.env.DB, target);
        if (!row) return c.json({ error: 'No such account' }, 404);
        // A deleted account's store was wiped, and the wipe is history like anything
        // else: a restore would bring its notes back, and they would sit there until the
        // sweep wiped them again. The directory's tombstone is the one thing that decides
        // an account is gone (see lib/sweep.ts), so it decides this too.
        if (row.deletedAt !== null) return c.json({ error: 'That account was deleted; its store is not restored.' }, 409);
      }

      let to: { at: number } | { bookmark: string };
      if (bookmark !== undefined) {
        to = { bookmark };
      } else {
        const ms = typeof at === 'number' ? at : Date.parse(at!);
        if (Number.isNaN(ms)) return c.json({ error: '`at` is neither milliseconds nor an ISO 8601 time.' }, 400);
        if (ms > Date.now()) return c.json({ error: '`at` is in the future.' }, 400);
        if (ms < Date.now() - RESTORE_WINDOW_MS) return c.json({ error: '`at` is more than thirty days ago; the store keeps no history that far back.' }, 400);
        to = { at: ms };
      }

      const store = storeFor(c.env, target);
      if (confirm !== 'RESTORE') {
        try {
          const preview = await store.restorePreview(to);
          return c.json({
            dryRun: true,
            user: target,
            ...preview,
            hint: `Dump the store first (GET /api/admin/store/dump?user=${target}), then repeat this request with "confirm": "RESTORE".`,
          });
        } catch (err) {
          const refused = readRestoreRefusal(err);
          if (refused !== null) return restoreRefused(c, refused);
          // A dry run schedules nothing, so whatever this was, nothing changed. Not
          // necessarily the connection: the object can fail on wake too, a pending
          // migration say, and the log line below is where that error is.
          console.error(`[store] restore preview failed for user=${target}:`, err);
          return c.json({ error: 'The dry run failed; nothing was scheduled. The Worker log has the error.' }, 502);
        }
      }

      console.log(`[store] operator=${email} restore user=${target} to=${'at' in to ? new Date(to.at).toISOString() : to.bookmark}`);
      // The directory's record of the last wind-back (MAK-189) is cleared before the
      // restore is scheduled, as the load route clears it before `loadBegin`. Cleared
      // after, every way out below that is not a clean answer — an outcome unknown, a
      // restore that will apply on the next restart, a failed write — would leave the
      // page offering the undo of an earlier wind-back, a press that throws this one
      // away under a confirm that says nothing of it (found in review). A refusal loses
      // the record for nothing, but only the page's copy: the bookmark is in the log.
      try {
        await clearRestore(c.env.DB, target);
      } catch (err) {
        console.error(`[store] clearing the recorded wind-back before a restore failed for user=${target}; the operator page may offer an undo from before this restore:`, err);
      }
      let undo: string | null;
      try {
        await store.restoreTo(to);
        // `restoreTo` aborts the object and so never returns; getting here means it did not,
        // which leaves the restore scheduled to fire by itself on the next restart — the
        // delayed hazard `restoreTo` exists to avoid. Said loudly, in the log and the answer.
        console.error(`[store] restore for user=${target} returned instead of restarting; it will apply on the store's next restart`);
        return c.json(
          {
            error:
              'The store did not restart, so the restore is scheduled but not yet applied. It will apply by itself the next time the store restarts; call this again to apply it now.',
          },
          500,
        );
      } catch (err) {
        const abort = readRestoreAbort(err);
        const refused = abort.scheduled ? null : readRestoreRefusal(err);
        if (refused !== null) return restoreRefused(c, refused);
        if (!abort.scheduled) {
          // Neither the abort nor a refusal: a dropped connection, an internal error, an
          // abort whose reason the runtime replaced. The restore may have been scheduled,
          // or applied, so this must not read as "nothing happened".
          console.error(`[store] restore outcome unknown for user=${target}:`, err);
          return c.json(
            {
              error:
                'The restore may have been applied. Check for a "[store] restore scheduled" line in the Worker log, and GET /api/admin/store/stats, before trying again.',
            },
            502,
          );
        }
        undo = abort.undo;
      }

      // The restore wound the feed's counter back with everything else; a new epoch
      // tells every device holding a cursor from the old history to start over, which
      // is the only safe thing a device under a rewound counter can do. Named before the
      // stats so the answer below can say whether it happened.
      let feedEpoch: string | null = null;
      try {
        feedEpoch = (await storeFor(c.env, target).feedRestored()).epoch;
      } catch (err) {
        console.error(`[store] feedRestored after restore failed for user=${target}:`, err);
      }
      let stats: StoreStats | null = null;
      try {
        stats = await storeFor(c.env, target).stats();
      } catch (err) {
        console.error(`[store] stats after restore failed for user=${target}:`, err);
      }
      // The way back, kept where a reload of the operator page finds it (MAK-189). Only
      // a wind-back to a moment is recorded; a restore to a bookmark — the undo itself —
      // leaves the record cleared above, since what it would offer next is the wind-back
      // again (`recordRestore` says why). The answer and the log carry the bookmark too,
      // so a failure here is logged and not answered.
      if ('at' in to) {
        try {
          await recordRestore(c.env.DB, target, { at: Date.now(), toAt: to.at, undo });
        } catch (err) {
          console.error(`[store] recording the wind-back in the directory failed for user=${target}; the operator page will not offer its undo after a reload:`, err);
        }
      }
      return c.json({
        restored: true,
        user: target,
        undo,
        feedEpoch,
        stats,
        note: [
          'The store restarted to apply the restore, so the request inside it failed by design.',
          undo
            ? 'To undo, restore to the `undo` bookmark.'
            : 'The undo bookmark did not survive the restart; the Worker log has it on the "[store] restore scheduled" line.',
          stats ? null : 'Reading the restored store failed; call GET /api/admin/store/stats again.',
          feedEpoch ? null : 'The feed was not given a new epoch; devices with a cursor may miss what is written next. Call POST /api/admin/store/feed-epoch for this account.',
        ]
          .filter(Boolean)
          .join(' '),
      });
    },
  )

  /**
   * Replaces one account's store with a dump from the backups bucket (MAK-171, part 4):
   * the way back from a fault noticed after the thirty days of history, and the last
   * step of the runbook for losing the whole Cloudflare account. `{ user, dump }`, where
   * `dump` is a date — that day's daily dump — or a key under the account's own
   * `stores/<user>/` prefix (`resolveDumpKey`), so a dump can only be loaded into the
   * account it was taken from. Operator only; a deleted account is refused as the
   * restore route refuses it; an instance with no backups bucket bound has no dumps to
   * load.
   *
   * A dry run unless the body says `confirm: "LOAD"`. The dry run reads the dump's head
   * and tail — whose it is, when it was taken, whether its rows are one moment of the
   * store — and shows the store as it is now. The real thing, in order:
   *
   * 1. Dump the store as it stands to `stores/<user>/<time>-before-load.sql`
   *    (`beforeLoadKey`), the same file the daily run writes, which the nightly mirror
   *    then copies off-account. It is the way back once the thirty days are up, and the
   *    only way back where the runtime keeps no history. A failure here changes nothing.
   * 2. `loadBegin`: the object takes its bookmark (the `undo` in the answer, which the
   *    restore route winds back to in one call), empties itself and marks itself
   *    loading. From here on the store refuses every request but these until step 4.
   *    The directory's record of the last wind-back is cleared just before (see there).
   * 3. Stream the file into the object in pages (`streamDump`).
   * 4. `loadFinish`: the object checks the dump is this account's and from a schema this
   *    code knows, applies any schema file the dump lacked, names a new feed epoch so
   *    every device starts over from a snapshot, and only then clears the mark.
   *
   * A failure after step 2 leaves the store loading, and the answer says so, with both
   * ways out: restore to `undo`, or load `before` — or call this again, which starts
   * over. Either of the last two is this route on a store that is already loading, so
   * step 1 is skipped then — a dump of a half-loaded store is not a way back, and
   * `dumpBegin` refuses it anyway — and the object keeps the `undo` and `before` of the
   * first attempt (found in review: the first version dumped first every time, and so
   * could never be called again). The dump object is opened after step 1 and before
   * step 2, so an R2 refusal is a load that never started rather than one that emptied
   * the store, and the open stream does not sit idle through an archive's dump. Logged
   * with both ids before anything is read.
   */
  .post(
    '/admin/store/load',
    requireAuth,
    zValidator('json', z.object({ user: z.string().optional(), dump: z.string().min(1), confirm: z.literal('LOAD').optional() })),
    async (c) => {
      const email = c.get('user')?.email;
      if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
      const bucket = c.env.BACKUPS;
      if (!bucket) return c.json({ error: 'This instance has no backups bucket bound, so there are no dumps to load.' }, 501);
      const { user, dump, confirm } = c.req.valid('json');
      const target = user ?? c.get('userId')!;
      if (target !== c.get('userId')) {
        const row = await directoryRow(c.env.DB, target);
        if (!row) return c.json({ error: 'No such account' }, 404);
        // As the restore route reasons: the owner asked for the notes to go, and a load
        // would bring them back under an account the sweep is wiping.
        if (row.deletedAt !== null) return c.json({ error: 'That account was deleted; its store is not loaded.' }, 409);
      }
      const key = resolveDumpKey(target, dump);
      if (!key) return c.json({ error: '`dump` must be a date (YYYY-MM-DD) or a key under this account\'s stores/ prefix.' }, 400);
      // The dry run reads the account too, so the line comes before either.
      console.log(`[store] operator=${email} load${confirm === 'LOAD' ? '' : ' dry-run'} user=${target} key=${key}`);
      const described = await describeDump(bucket, key);
      if (!described) return c.json({ error: `No dump at ${key}.` }, 404);
      if (described.owner !== target) {
        return c.json({ error: `${key} is not a dump of this account: its first line names ${described.owner ?? 'no account'}.` }, 409);
      }

      const store = storeFor(c.env, target);
      const current = await store.stats();
      if (confirm !== 'LOAD') {
        return c.json({
          dryRun: true,
          user: target,
          dump: described,
          current,
          hint: current.loading
            ? `The store is loading ${current.loading.key} and refusing requests; repeat this request with "confirm": "LOAD" to start over with ${key}.`
            : `Repeat this request with "confirm": "LOAD" to replace the store with ${key}. The store as it is now is dumped first, and the answer names the file.`,
        });
      }

      let before: string | null = null;
      if (current.loading) {
        console.log(`[store] load for user=${target} starts over on a store already loading ${current.loading.key}; no dump taken first`);
      } else {
        before = beforeLoadKey(target, Date.now());
        try {
          await dumpBeforeLoad(store, bucket, target, before, loadReserve(described.size));
        } catch (err) {
          console.error(`[store] load for user=${target}: the dump before it failed; nothing changed:`, err);
          return c.json({ error: `Dumping the store as it stands failed, so nothing was loaded: ${err instanceof Error ? err.message : String(err)}` }, 502);
        }
      }

      const object = await bucket.get(key);
      if (!object) return c.json({ error: `${key} went away since the dry run; nothing was loaded.`, before }, 404);

      // The wind-back the directory may still record (MAK-189) stops describing a way
      // back the moment the store is emptied: its bookmark is from before this load, and
      // undoing to it would throw the loaded dump away under a confirm that says nothing
      // of the kind. Cleared before `loadBegin` rather than after, so a begin that empties
      // the store and then fails to answer cannot leave the record standing (found in
      // review); clearing early loses nothing, since the bookmark is in the Worker's log.
      // The load records nothing in its place: its own way back is the before-load dump
      // above, listed for as long as the bucket keeps it. Logged and not answered, as the
      // restore route treats its record.
      try {
        await clearRestore(c.env.DB, target);
      } catch (err) {
        console.error(`[store] clearing the recorded wind-back before a load failed for user=${target}; the operator page may offer an undo from before the load:`, err);
      }

      let begun: { loadId: string; undo: string | null; before: string | null };
      try {
        begun = await store.loadBegin({ key, before });
      } catch (err) {
        // The call may have emptied the store before it failed to answer. Not "nothing
        // changed": `stats` says whether the store is loading.
        console.error(`[store] loadBegin for user=${target} failed:`, err);
        return c.json(
          { error: 'Starting the load failed, and the store may already be emptied and marked loading. Check GET /api/admin/store/stats; if it says loading, restore to the pre-load dump or call this again.', before },
          502,
        );
      }
      before = begun.before;

      let result;
      try {
        result = await streamDump(store, object.body, begun.loadId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[store] load for user=${target} from ${key} failed; the store is still marked loading:`, err);
        return c.json(
          {
            error: `The load failed: ${message}`,
            loading: true,
            user: target,
            undo: begun.undo,
            before,
            hint: [
              'The store is refusing every request until it is whole again.',
              begun.undo ? `POST /api/admin/store/restore with { "user", "bookmark": "${begun.undo}", "confirm": "RESTORE" } puts it back as it was.` : null,
              before ? `Or load ${before}, the dump taken before the store was emptied; or call this again to start over.` : 'Or call this again to start over.',
            ]
              .filter(Boolean)
              .join(' '),
          },
          502,
        );
      }

      return c.json({
        loaded: true,
        user: target,
        key,
        before,
        undo: begun.undo,
        feedEpoch: result.feedEpoch,
        pages: result.pages,
        statements: result.statements,
        migrated: result.migrated,
        foreignKeyViolations: result.foreignKeyViolations,
        stats: result.stats,
        note: [
          `The store now holds ${key}; every device of the account will resync from a snapshot.`,
          begun.undo ? 'To undo, restore to the `undo` bookmark.' : before ? `To undo, load ${before}; this runtime keeps no bookmarks.` : 'There is nothing to undo to: this runtime keeps no bookmarks and no dump was taken first.',
          result.migrated.length ? `Schema files the dump lacked were applied: ${result.migrated.join(', ')}.` : null,
          result.foreignKeyViolations ? `${result.foreignKeyViolations} row(s) point at a parent the dump does not hold; the dump was read while the store was written to.` : null,
        ]
          .filter(Boolean)
          .join(' '),
      });
    },
  )

  /**
   * One store as SQL text: `sqlite3 account.db < dump.sql` rebuilds it, with nothing from
   * this repository needed. What `d1 export` was for the shared database, and how a
   * migration is rehearsed against a real account before it ships: dump, load, run the
   * new schema file's SQL against the copy. The file and its order are `lib/dump.ts`'s,
   * shared with the daily backup.
   *
   * Streamed a slice per pull, so an archive's worth of texts never sits in the Worker's
   * memory at once — not even for a client that reads slowly, which is what enqueuing
   * every slice from `start` would have allowed. Every slice is one store call, and an
   * invocation has fifty on Free: a 13k-note archive with 4k files and 2.4k texts (about
   * 31 MB of SQL) is about five.
   */
  .get('/admin/store/dump', requireAuth, async (c) => {
    const target = await operatorTarget(c);
    if (target instanceof Response) return target;
    // Asked for no mark, so the store always answers with its rows.
    const chunks = (await beginDump(storeFor(c.env, target), target)).chunks!;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel() {
        void chunks.return(undefined);
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="unbent-store-${target}.sql"`,
        'Cache-Control': 'no-store',
      },
    });
  })

  /**
   * One batch of the walk, on demand: after a deploy that carries a schema file, so every
   * account is migrated within minutes rather than hours. The answer says whether the
   * pass is `done`; a caller sends `?restart=1` on the first call, so the pass starts at
   * the top rather than wherever the cron's cursor is, and calls again without it until
   * it is. See lib/sweep.ts.
   *
   * Two ways in. The deploy workflows send `SWEEP_TOKEN` in a header, since CI has no
   * session (scripts/sweep-stores.mjs); a person sends an operator session. A request
   * carrying the header is judged on the token alone and never falls through to the
   * session, so a wrong token is a 404 rather than a 401 that reads as "sign in".
   */
  .post('/admin/store/sweep', sweepByToken, requireAuth, async (c) => {
    const email = c.get('user')?.email;
    if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
    console.log(`[store] operator=${email} sweep`);
    return c.json(await sweepStores(c.env, { restart: c.req.query('restart') === '1' }));
  })

  /**
   * The backup's health, for the operator page (MAK-171, part 5): the two status files
   * the backup leaves in the backups bucket, read as they are. `status/dumps.json` is
   * what the daily run wrote last (`lib/backups.ts`), `status/mirror.json` what the
   * nightly mirror wrote (`scripts/mirror/write-status.mjs`); either is null until its
   * run has written one. An instance with no bucket bound answers `bound: false`, which
   * the page draws as "backups are not set up here" rather than as empty numbers.
   *
   * This is also how the page learns the session is an operator's: `/api/config` is
   * public and answers before there is a session, so it cannot say, and this route
   * answers a non-operator as the others do, as if it did not exist.
   */
  .get('/admin/backups', requireAuth, async (c) => {
    const email = c.get('user')?.email;
    if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
    const bucket = c.env.BACKUPS;
    if (!bucket) return c.json({ bound: false } satisfies BackupsStatus);
    const [dumps, mirror] = await Promise.all([readStatus<DumpStatus>(bucket, STATUS_KEY), readStatus<MirrorStatus>(bucket, MIRROR_STATUS_KEY)]);
    return c.json({ bound: true, dumps, mirror } satisfies BackupsStatus);
  })

  /**
   * Every live account as the directory knows it, with its email from `user` and the
   * daily backup's record of its newest dump. One D1 query a page, by user id as the
   * sweep's `listDirectory` pages; the counts are the last sweep's, which is right for
   * a view across accounts (`lib/directory.ts`). Logged, as any read of other people's
   * accounts here is.
   */
  .get('/admin/accounts', requireAuth, async (c) => {
    const email = c.get('user')?.email;
    if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
    console.log(`[store] operator=${email} accounts`);
    // `after` is the previous page's `next`; `limit` is clamped, since a page is a D1
    // read and the client has no business asking for more than the list draws.
    const limit = Math.min(OPERATOR_PAGE_MAX, Math.max(1, Number(c.req.query('limit')) || 50));
    return c.json(await listOperatorAccounts(c.env.DB, c.req.query('after') ?? '', limit));
  })

  /**
   * One account as the list shows it, for the account's own page, which must not need
   * the list: an operator following a link opens one account, and a list that pages
   * holds no promise of having reached it. Logged with both ids like every other read.
   */
  .get('/admin/accounts/:id', requireAuth, async (c) => {
    const email = c.get('user')?.email;
    if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
    const id = c.req.param('id');
    console.log(`[store] operator=${email} account user=${id}`);
    const account = await readOperatorAccount(c.env.DB, id);
    return account ? c.json(account) : c.json({ error: 'No such account' }, 404);
  })

  /**
   * One account's dumps: what is under its `stores/<user>/` prefix in the backups
   * bucket, the daily files and any the load route wrote before a load. The bucket's
   * lifecycle rule deletes a dump after `DUMPS_KEPT_DAYS` (in `@unbent/shared`, since
   * the page states it), so an older one is in the mirror alone. 501 with no bucket, as
   * the load route answers.
   */
  .get('/admin/accounts/:id/dumps', requireAuth, async (c) => {
    const target = await operatorAccount(c, c.req.param('id'));
    if (target instanceof Response) return target;
    const bucket = c.env.BACKUPS;
    if (!bucket) return c.json({ error: 'This instance has no backups bucket bound, so there are no dumps to list.' }, 501);
    const prefix = dumpPrefix(target);
    const dumps: AccountDumps['dumps'] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await bucket.list({ prefix, cursor });
      for (const o of page.objects) dumps.push({ key: o.key, name: o.key.slice(prefix.length), size: o.size, uploadedAt: o.uploaded.toISOString() });
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    // Newest first, by name: a name carries the day it was taken (and the time, for a
    // dump written before a load), which is what "newest" means here — a dump copied
    // back from the mirror is uploaded today and taken weeks ago.
    dumps.sort((a, b) => (a.name < b.name ? 1 : -1));
    return c.json({ dumps } satisfies AccountDumps);
  })

  /**
   * One of those dumps, as a download. The name is the file's under the account's
   * prefix and nothing else (`resolveDumpDownload`, which is the load route's rule for
   * what may be named), so this can only ever hand out a file of the account named.
   */
  .get('/admin/accounts/:id/dumps/:name', requireAuth, async (c) => {
    const target = await operatorAccount(c, c.req.param('id'));
    if (target instanceof Response) return target;
    const bucket = c.env.BACKUPS;
    if (!bucket) return c.json({ error: 'This instance has no backups bucket bound.' }, 501);
    const download = resolveDumpDownload(target, c.req.param('name'));
    if (!download) return c.json({ error: 'Not a dump of this account.' }, 400);
    const object = await bucket.get(download.key);
    if (!object) return c.json({ error: `No dump at ${download.key}.` }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Length': String(object.size),
        'Content-Disposition': `attachment; filename="${download.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });

/**
 * A status file from the backups bucket as JSON, or null when no run has written it yet.
 * A file that does not parse — a write cut short — is logged and answered as null too:
 * the alternative is a 500 from the one route that also tells the page whose session
 * this is, which would take the whole tab away over one half's status.
 */
async function readStatus<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return (await object.json()) as T;
  } catch (err) {
    console.error(`[backup] ${key} is not readable JSON:`, err);
    return null;
  }
}

/**
 * An operator reading `id`'s account: the operator check, the directory check (a
 * mistyped id must not bootstrap an object; see `operatorTarget`), and the log line
 * with both ids. The routes whose account is in their path call it for every caller,
 * their own account included, since the page is the operator's alone; `operatorTarget`
 * calls it once `?user=` names someone else.
 */
async function operatorAccount(c: Context<AppEnv>, id: string): Promise<string | Response> {
  const email = c.get('user')?.email;
  if (!isOperator(c.env, email)) return c.json({ error: 'Not found' }, 404);
  if (!(await directoryRow(c.env.DB, id))) return c.json({ error: 'No such account' }, 404);
  console.log(`[store] operator=${email} read user=${id}`);
  return id;
}


/**
 * A restore the runtime refused before scheduling anything: 501 where it keeps no history
 * at all (Miniflare, so `pnpm dev`), otherwise 400 with the runtime's own words — a
 * bookmark it does not know, a time it cannot reach. Only for a refusal the object marked
 * (`readRestoreRefusal`); any other failure is not known to be harmless.
 */
function restoreRefused(c: Context<AppEnv>, message: string): Response {
  if (isRestoreUnsupported(message)) {
    return c.json({ error: 'This runtime keeps no history to restore from. Restores work on a deployed instance only.' }, 501);
  }
  return c.json({ error: message }, 400);
}

/**
 * Whose store a `stats` or `dump` reads: the caller's own, or, for an operator naming
 * `?user=`, someone else's — logged, because that is one person reading another's notes.
 * A non-operator naming anyone is answered as if the route did not exist, the way every
 * other "is this mine" check here answers.
 *
 * The name has to be in the directory. `storeFor` gets or creates an object for any
 * string, so a mistyped id would bootstrap a schema, probe D1 and leave an object behind
 * that no directory row knows about and the sweep would never find.
 */
async function operatorTarget(c: Context<AppEnv>): Promise<string | Response> {
  const asked = c.req.query('user');
  const own = c.get('userId')!;
  if (!asked || asked === own) return own;
  return operatorAccount(c, asked);
}
