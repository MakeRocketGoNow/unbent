import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { dumpKey, dumpStores, REFRESH_MS, STATUS_KEY, type DumpStatus } from '@unbent/api/lib/backups';

/**
 * The daily dumps (MAK-171, part 2), against real objects, a local D1 carrying the two
 * control-plane tables the run reads, and Miniflare's R2. The files bucket stands in for
 * the backups bucket: the local environment binds none, on purpose, so `pnpm dev` never
 * dumps. What a real bucket does that Miniflare's may not — its lifecycle rule, a
 * multipart upload's limits as production enforces them — is not checked here.
 *
 * The directory is this file's own and emptied before each test, since the run takes
 * every account it finds due.
 */

const DAY = 86_400_000;
/** A run at :47 on a fixed day, so keys and "today" are known. */
const NOON = Date.UTC(2026, 9, 5, 12, 47);
const backups = () => ({ ...env, BACKUPS: env.BLOBS });

beforeAll(async () => {
  await env.DB.exec(
    [
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS account_directory (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, migrated_at INTEGER, storage_bytes INTEGER NOT NULL DEFAULT 0, note_count INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER, deleted_at INTEGER, copied_at INTEGER, dump_at INTEGER, dump_bytes INTEGER, dump_mark TEXT, dump_checked_at INTEGER, dump_tried_at INTEGER, dump_error TEXT);`,
    ].join(' '),
  );
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM account_directory`), env.DB.prepare(`DELETE FROM user`)]);
});

/** A live account: a user row and a directory row made an hour before the run. */
async function account(label: string, opts: { deletedAt?: number; userRow?: boolean; createdAt?: number } = {}) {
  const id = `backup-${label}-${crypto.randomUUID()}`;
  if (opts.userRow !== false) {
    await env.DB.prepare(`INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES (?1, 'T', ?2, 'now', 'now')`).bind(id, `${id}@example.test`).run();
  }
  await env.DB.prepare(`INSERT INTO account_directory (user_id, created_at, deleted_at) VALUES (?1, ?2, ?3)`)
    .bind(id, opts.createdAt ?? NOON - 3_600_000, opts.deletedAt ?? null)
    .run();
  return { id, stub: env.USER_STORE.get(env.USER_STORE.idFromName(id)) };
}

async function directory(id: string) {
  return env.DB.prepare(`SELECT dump_at, dump_bytes, dump_mark, dump_checked_at, dump_tried_at, dump_error FROM account_directory WHERE user_id = ?1`)
    .bind(id)
    .first<{ dump_at: number | null; dump_bytes: number | null; dump_mark: string | null; dump_checked_at: number | null; dump_tried_at: number | null; dump_error: string | null }>();
}

async function status(): Promise<DumpStatus> {
  return JSON.parse(await (await env.BLOBS.get(STATUS_KEY))!.text()) as DumpStatus;
}

/** Three texts of five megabytes: a dump of about sixteen, more than one part. */
async function bigStore(stub: ReturnType<typeof env.USER_STORE.get>) {
  await runInDurableObject(stub, (_i, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('n1', 'T', 'b', 1, 1)`);
    for (let i = 0; i < 3; i++) {
      sql.exec(`INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at) VALUES (?1, 'n1', ?2, 'application/pdf', 1, ?1, 1)`, `a${i}`, `f${i}.pdf`);
      sql.exec(`INSERT INTO attachment_text (attachment_id, note_id, filename, text, created_at) VALUES (?1, 'n1', ?2, ?3, 1)`, `a${i}`, `f${i}.pdf`, 'x'.repeat(5 * 1024 * 1024));
    }
  });
}

describe('the daily dumps', () => {
  it('do nothing, and touch nothing, where no backups bucket is bound', async () => {
    const untouchable = new Proxy({} as D1Database, {
      get() {
        throw new Error('the run touched D1 with no bucket bound');
      },
    });
    expect(await dumpStores({ ...env, DB: untouchable, BACKUPS: undefined })).toBeNull();
  });

  it('dump a live account to its day, record it, and write the status', async () => {
    const { id, stub } = await account('live');
    await stub.create({ id: crypto.randomUUID(), title: 'Kept', body: 'in the backup', tags: ['one'] });
    const gone = await account('tombstoned', { deletedAt: NOON - DAY });
    const userless = await account('userless', { userRow: false });

    const report = await dumpStores(backups(), { now: NOON });
    expect(report).toMatchObject({ dumped: 1, unchanged: 0, failed: [], deferred: [], done: true });

    const object = await env.BLOBS.get(dumpKey(id, NOON));
    expect(dumpKey(id, NOON)).toBe(`stores/${id}/2026-10-05.sql`);
    const sql = await object!.text();
    expect(object!.httpMetadata?.contentType).toContain('application/sql');
    expect(sql).toMatch(new RegExp(`^-- Unbent note store of account ${id}, dumped `));
    expect(sql).toContain("'Kept'");
    expect(sql.trimEnd().endsWith('PRAGMA foreign_keys = ON;')).toBe(true);

    expect(await directory(id)).toMatchObject({ dump_at: NOON, dump_bytes: object!.size, dump_checked_at: NOON, dump_tried_at: NOON, dump_error: null });
    expect((await directory(id))!.dump_mark).toMatch(/:\d+$/);
    // Gone accounts are the sweep's, and their stores are never woken here.
    expect(await env.BLOBS.head(dumpKey(gone.id, NOON))).toBeNull();
    expect(await env.BLOBS.head(dumpKey(userless.id, NOON))).toBeNull();

    expect(await status()).toMatchObject({
      ranAt: new Date(NOON).toISOString(),
      run: { dumped: 1, failed: 0, deferred: 0, bytes: object!.size, subrequests: 6 },
      accounts: 1,
      failing: [],
      failingCount: 0,
      stale: [],
      staleCount: 0,
    });
  });

  it('try each account once a day, dump it again only when it changed, and at least weekly', async () => {
    const { id, stub } = await account('daily');
    await stub.create({ id: crypto.randomUUID(), title: 'One', body: 'b', tags: [] });
    expect(await dumpStores(backups(), { now: NOON })).toMatchObject({ dumped: 1 });

    // Later the same day: already tried, so not even its store is asked.
    expect(await dumpStores(backups(), { now: NOON + 3_600_000 })).toMatchObject({ dumped: 0, unchanged: 0, subrequests: 3 });

    // The next day, unchanged: one call, recorded as checked, and no new file.
    const next = NOON + DAY;
    expect(await dumpStores(backups(), { now: next })).toMatchObject({ dumped: 0, unchanged: 1, subrequests: 4 });
    expect(await env.BLOBS.head(dumpKey(id, next))).toBeNull();
    expect(await directory(id)).toMatchObject({ dump_at: NOON, dump_checked_at: next, dump_tried_at: next });

    // The day after, changed: a new file for the new day, the old one left to the lifecycle rule.
    await stub.create({ id: crypto.randomUUID(), title: 'Two', body: 'b', tags: [] });
    const third = NOON + 2 * DAY;
    expect(await dumpStores(backups(), { now: third })).toMatchObject({ dumped: 1 });
    expect(await env.BLOBS.head(dumpKey(id, third))).not.toBeNull();
    expect(await env.BLOBS.head(dumpKey(id, NOON))).not.toBeNull();

    // A week on with nothing changed, the newest dump is about to age out of the bucket,
    // so it is written again anyway.
    const week = third + REFRESH_MS;
    expect(await dumpStores(backups(), { now: week })).toMatchObject({ dumped: 1, unchanged: 0 });
    expect(await directory(id)).toMatchObject({ dump_at: week });
  });

  it('record each dump as it finishes, so a run that dies after it does not dump it again', async () => {
    const { id, stub } = await account('dies');
    await stub.create({ id: crypto.randomUUID(), title: 'One', body: 'b', tags: [] });
    const dying = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'batch') return () => Promise.reject(new Error('the isolate went away'));
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(dumpStores({ ...backups(), DB: dying }, { now: NOON })).rejects.toThrow('went away');
    expect(await directory(id)).toMatchObject({ dump_at: NOON, dump_tried_at: NOON });
    // So the next run, the same day, finds it done rather than writing its key again.
    expect(await dumpStores(backups(), { now: NOON + 3_600_000 })).toMatchObject({ dumped: 0, subrequests: 3 });
  });

  it('stream a dump bigger than a part as a multipart upload of equal parts', async () => {
    const { id, stub } = await account('big');
    await bigStore(stub);
    const partBytes = 5 * 1024 * 1024;
    const report = await dumpStores(backups(), { now: NOON, partBytes });
    expect(report).toMatchObject({ dumped: 1, failed: [] });
    const object = await env.BLOBS.get(dumpKey(id, NOON));
    const sql = await object!.text();
    expect(object!.size).toBeGreaterThan(3 * partBytes);
    expect(object!.size).toBe(report!.bytes);
    expect([...sql.matchAll(/^INSERT INTO attachment_text /gm)]).toHaveLength(3);
    expect(sql.trimEnd().endsWith('PRAGMA foreign_keys = ON;')).toBe(true);
    // The fixed three; `dumpBegin` and two more slices; the upload's create, four parts
    // and completion; the account's directory row.
    expect(report!.subrequests).toBe(13);
  });

  it('record a dump that cannot fit one invocation as failed, and leave no half-written file', async () => {
    const { id, stub } = await account('toobig');
    await bigStore(stub);
    const report = await dumpStores(backups(), { now: NOON, budget: 8, partBytes: 5 * 1024 * 1024 });
    expect(report).toMatchObject({ dumped: 0, failed: [id], deferred: [] });
    expect(report!.subrequests).toBeLessThanOrEqual(8);
    expect(await env.BLOBS.head(dumpKey(id, NOON))).toBeNull();
    expect(await directory(id)).toMatchObject({ dump_at: null, dump_tried_at: NOON, dump_error: expect.stringContaining('more than the 8 subrequests') });
    expect(await status()).toMatchObject({ failingCount: 1, failing: [{ userId: id, error: expect.stringContaining('subrequests'), triedAt: new Date(NOON).toISOString() }] });
    // Tried today, so the next run leaves it for tomorrow rather than failing again.
    expect(await dumpStores(backups(), { now: NOON + 3_600_000, budget: 8 })).toMatchObject({ failed: [], subrequests: 3 });
  });

  it('never open an upload with the last call it may make, so the abort is always affordable', async () => {
    const { id, stub } = await account('edge');
    await bigStore(stub);
    // The fixed three and `dumpBegin` leave one call: enough to open the upload, not to
    // abort it after. So it is never opened.
    for (const budget of [5, 6, 7, 8]) {
      await env.DB.prepare(`UPDATE account_directory SET dump_tried_at = NULL, dump_error = NULL WHERE user_id = ?1`).bind(id).run();
      const report = await dumpStores(backups(), { now: NOON, budget, partBytes: 5 * 1024 * 1024 });
      expect(report!.subrequests, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(report, `budget ${budget}`).toMatchObject({ failed: [id] });
    }
  });

  it('stop at an account the budget ran out on, and start the next run with it', async () => {
    // Ids sort the small one first, so it spends part of the budget before the big one.
    const small = await account('a-small');
    await small.stub.create({ id: crypto.randomUUID(), title: 'Small', body: 'b', tags: [] });
    const big = await account('b-big');
    await bigStore(big.stub);
    const after = await account('c-after');

    const first = await dumpStores(backups(), { now: NOON, budget: 9, partBytes: 5 * 1024 * 1024 });
    expect(first).toMatchObject({ dumped: 1, failed: [], deferred: [big.id], done: false });
    expect(first!.subrequests).toBeLessThanOrEqual(9);
    expect(await directory(big.id)).toMatchObject({ dump_tried_at: null, dump_error: null });
    // Not reached: the run stopped at the big one rather than go past it.
    expect(await directory(after.id)).toMatchObject({ dump_tried_at: null });

    // The next run has the whole budget for it, and is first in line.
    const second = await dumpStores(backups(), { now: NOON + 3_600_000, budget: 20, partBytes: 5 * 1024 * 1024 });
    expect(second).toMatchObject({ dumped: 2, failed: [], deferred: [], done: true });
    expect(await env.BLOBS.head(dumpKey(big.id, NOON))).not.toBeNull();
  });

  it('call an account stale once no run has found its dump current for two days', async () => {
    const old = await account('old', { createdAt: NOON - 10 * DAY });
    const young = await account('young', { createdAt: NOON - 3_600_000 });
    // A budget that reaches nobody: the status is still written, and says who is waiting.
    await dumpStores(backups(), { now: NOON, budget: 4 });
    expect(await status()).toMatchObject({ accounts: 2, staleCount: 1, stale: [old.id], staleAfterHours: 48 });
    expect((await status()).stale).not.toContain(young.id);
  });
});
