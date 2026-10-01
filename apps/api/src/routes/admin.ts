import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { deleteKeys } from '../lib/blobs.js';
import { directoryRow, dropDirectoryRow } from '../lib/directory.js';
import { isOperator } from '../lib/instance.js';
import { userPrefix } from '../lib/repo.js';
import { storeFor } from '../lib/store-client.js';
import { sweepStores } from '../lib/sweep.js';
import { SWEEP_TOKEN_HEADER, sweepTokenMatches } from '../lib/sweep-token.js';
import { DUMP_TABLES } from '../store/tables.js';
import { BOOKMARK_PATTERN, RESTORE_WINDOW_MS, isRestoreUnsupported, readRestoreAbort, readRestoreRefusal } from '../store/restore.js';
import type { StoreStats, UserStore } from '../store/user-store.js';
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
          // A dry run schedules nothing, so whatever this was, nothing changed.
          console.error(`[store] restore preview failed for user=${target}:`, err);
          return c.json({ error: 'The store could not be reached. Nothing was scheduled; try again.' }, 502);
        }
      }

      console.log(`[store] operator=${email} restore user=${target} to=${'at' in to ? new Date(to.at).toISOString() : to.bookmark}`);
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

      let stats: StoreStats | null = null;
      try {
        stats = await storeFor(c.env, target).stats();
      } catch (err) {
        console.error(`[store] stats after restore failed for user=${target}:`, err);
      }
      return c.json({
        restored: true,
        user: target,
        undo,
        stats,
        note: [
          'The store restarted to apply the restore, so the request inside it failed by design.',
          undo
            ? 'To undo, restore to the `undo` bookmark.'
            : 'The undo bookmark did not survive the restart; the Worker log has it on the "[store] restore scheduled" line.',
          stats ? null : 'Reading the restored store failed; call GET /api/admin/store/stats again.',
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
   * new schema file's SQL against the copy.
   *
   * The order is what makes the file loadable rather than merely complete. Tables and
   * indexes come first, then every row, then the triggers and the FTS tables, then a
   * rebuild of each FTS index from the rows. Rows before triggers, because the count
   * triggers would otherwise add every note a second time to counts the notebook and tag
   * rows already carry, and the FTS insert triggers would index each row on the way in
   * only to have `rebuild` do it again. `_migrations` and `_meta` travel too, so the
   * copy says which schema files it is at and whose it was.
   *
   * Paged out of the object by rowid as it streams, one page per pull, so an archive's
   * worth of texts never sits in the Worker's memory at once — not even for a client that
   * reads slowly, which is what enqueuing every page from `start` would have allowed.
   * Big pages, cut by bytes inside the object: every
   * page is one store call and an invocation has fifty on Free, so a 13k-note archive with
   * 4k files and 2.4k texts (about 22 MB of them) is roughly a dozen calls — the small
   * tables one each, notes three, texts three or four by the byte cut — where five
   * hundred rows a page would have been sixty and failed partway through the texts.
   */
  .get('/admin/store/dump', requireAuth, async (c) => {
    const target = await operatorTarget(c);
    if (target instanceof Response) return target;
    const chunks = dumpChunks(storeFor(c.env, target), target);
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
  });


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
 * The dump as chunks: the header and the tables, then each page of each table as the
 * object formats and encodes it, then the triggers, the FTS tables and their rebuild. A
 * generator so the stream above fetches one chunk per pull and a page is only read from
 * the object once the client has taken the last one. Bytes throughout: the pages arrive
 * encoded, and the Worker touches none of their content (see `dumpPage`).
 */
async function* dumpChunks(store: DurableObjectStub<UserStore>, target: string): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const schema = await store.schemaSql();
  const later = (s: string) => /^CREATE (VIRTUAL TABLE|TRIGGER)\b/i.test(s);
  const head = [
    `-- Unbent note store of account ${target}, dumped ${new Date().toISOString()}`,
    `-- Rebuild with: sqlite3 account.db < this-file.sql`,
    'PRAGMA foreign_keys = OFF;',
    'BEGIN;',
    ...schema.filter((s) => !later(s)).map((s) => `${s};`),
  ];
  yield encoder.encode(`${head.join('\n')}\n`);
  for (const table of DUMP_TABLES) {
    for (let after = 0; ; ) {
      // Formatted and encoded inside the object, where the CPU budget is; see `dumpPage`.
      const page = await store.dumpPage(table, after, 5000);
      if (page.rows > 0) yield page.bytes;
      if (page.nextRowid === null) break;
      after = page.nextRowid;
    }
  }
  const tail = schema.filter(later).map((s) => `${s};`);
  for (const fts of schema.filter((s) => /^CREATE VIRTUAL TABLE/i.test(s))) {
    const name = /^CREATE VIRTUAL TABLE\s+(\S+)/i.exec(fts)![1];
    tail.push(`INSERT INTO ${name}(${name}) VALUES ('rebuild');`);
  }
  tail.push('COMMIT;', 'PRAGMA foreign_keys = ON;');
  yield encoder.encode(`${tail.join('\n')}\n`);
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
async function operatorTarget(c: { env: AppEnv['Bindings']; req: { query(name: string): string | undefined }; get(key: 'userId'): string | undefined; get(key: 'user'): { email: string } | undefined }): Promise<string | Response> {
  const asked = c.req.query('user');
  const own = c.get('userId')!;
  if (!asked || asked === own) return own;
  const email = c.get('user')?.email;
  if (!isOperator(c.env, email)) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!(await directoryRow(c.env.DB, asked))) return Response.json({ error: 'No such account' }, { status: 404 });
  console.log(`[store] operator=${email} read user=${asked}`);
  return asked;
}
