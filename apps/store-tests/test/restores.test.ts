import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { RESTORES_LISTED } from '@unbent/shared';
import { dropRestore, dropRestoresStatement, listRestores, settleRestore, startRestore, undoneRow } from '@unbent/api/lib/restores';
import { RESTORES_DDL } from './helpers.js';

/**
 * The restore history (migration 0041, MAK-198) against a real D1, in the order the
 * restore and load routes write it. The routes cannot run here — the runtime keeps no
 * history to restore from — so what is pinned is each step's effect on the list the
 * operator page reads: a row started before the store is touched, settled by its answer,
 * gone when the runtime refused, and an undo that names the row it undid.
 *
 * Each test takes its own account id; nothing empties the table between them.
 */

beforeAll(async () => {
  await env.DB.exec(
    [
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS account_directory (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, restore_at INTEGER, restore_to_at INTEGER, restore_undo TEXT);`,
      ...RESTORES_DDL,
    ].join(' '),
  );
});

const account = (label: string) => `restores-${label}-${crypto.randomUUID()}`;
const BOOKMARK = '00000001-00000002-00000003-0000000000000004';

/** A row started with no precondition, which is always written. */
const start = async (row: Parameters<typeof startRestore>[1]) => (await startRestore(env.DB, row))!;

async function operator(): Promise<string> {
  const id = `op-${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES (?1, 'Op', ?2, 'now', 'now')`).bind(id, `${id}@example.test`).run();
  return id;
}

describe('the restore history', () => {
  it('keeps a wind-back started until its answer, then applied with its bookmark and the operator who asked', async () => {
    const user = account('wind');
    const op = await operator();
    const id = await start({ userId: user, operatorId: op, kind: 'moment', toAt: 1000 });
    // Before the answer: listed, and without a bookmark, so nothing beneath it is offered.
    expect((await listRestores(env.DB, user)).restores).toMatchObject([{ id, kind: 'moment', state: 'started', appliedAt: null, toAt: 1000, undo: null }]);

    await settleRestore(env.DB, id, { state: 'applied', undo: BOOKMARK });
    const [row] = (await listRestores(env.DB, user)).restores;
    expect(row).toMatchObject({ state: 'applied', undo: BOOKMARK, operator: { id: op, email: `${op}@example.test` } });
    expect(row!.appliedAt).toBeGreaterThanOrEqual(row!.startedAt);
  });

  it('writes an undo only while the row it was offered under is still the newest', async () => {
    const user = account('newest');
    const op = await operator();
    // Nothing yet: the newest is 0.
    const first = await startRestore(env.DB, { userId: user, operatorId: op, kind: 'moment', toAt: 1000, ifNewest: 0 });
    expect(first).not.toBeNull();
    // A second operator's wind-back lands while the page still shows the first as newest.
    const second = await start({ userId: user, operatorId: op, kind: 'moment', toAt: 2000 });
    expect(await startRestore(env.DB, { userId: user, operatorId: op, kind: 'bookmark', undoes: first, ifNewest: first! })).toBeNull();
    expect((await listRestores(env.DB, user)).restores.map((r) => r.id)).toEqual([second, first]);
    expect(await startRestore(env.DB, { userId: user, operatorId: op, kind: 'bookmark', undoes: second, ifNewest: second! })).not.toBeNull();
  });

  it("clears 0038's record of the account as it starts a row, so a rolled-back Worker offers no stale undo", async () => {
    const user = account('rollback');
    await env.DB.prepare(`INSERT INTO account_directory (user_id, created_at, restore_at, restore_to_at, restore_undo) VALUES (?1, 1, 2000, 1000, ?2)`).bind(user, BOOKMARK).run();
    await start({ userId: user, operatorId: await operator(), kind: 'load', dump: 'stores/x/2026-10-05.sql' });
    expect(await env.DB.prepare(`SELECT restore_at, restore_to_at, restore_undo FROM account_directory WHERE user_id = ?1`).bind(user).first()).toEqual({
      restore_at: null,
      restore_to_at: null,
      restore_undo: null,
    });
  });

  it('records nothing for a restore the runtime refused', async () => {
    const user = account('refused');
    const id = await start({ userId: user, operatorId: await operator(), kind: 'moment', toAt: 1000 });
    await dropRestore(env.DB, id);
    expect(await listRestores(env.DB, user)).toEqual({ restores: [], more: false });
  });

  it('finds the row an undo goes back to by its bookmark, and marks that row undone', async () => {
    const user = account('undo');
    const op = await operator();
    const wound = await start({ userId: user, operatorId: op, kind: 'moment', toAt: 1000 });
    await settleRestore(env.DB, wound, { state: 'applied', undo: BOOKMARK });
    // Another account's row with the same bookmark is not this account's to undo.
    const other = await start({ userId: account('other'), operatorId: op, kind: 'moment', toAt: 1000 });
    await settleRestore(env.DB, other, { state: 'applied', undo: BOOKMARK });

    expect(await undoneRow(env.DB, user, BOOKMARK)).toBe(wound);
    expect(await undoneRow(env.DB, user, '00000001-00000002-00000003-0000000000000009')).toBeNull();

    const undo = await start({ userId: user, operatorId: op, kind: 'bookmark', undoes: wound });
    await settleRestore(env.DB, undo, { state: 'applied', undo: null });
    const { restores } = await listRestores(env.DB, user);
    expect(restores.map((r) => [r.id, r.undoes, r.undoneBy])).toEqual([
      [undo, wound, null],
      [wound, null, undo],
    ]);
  });

  it("keeps a load's way back from the moment its bookmark is taken, through a load that stops partway", async () => {
    const user = account('load');
    const id = await start({ userId: user, operatorId: await operator(), kind: 'load', dump: `stores/${user}/2026-10-05.sql` });
    await settleRestore(env.DB, id, { state: 'started', undo: BOOKMARK, before: `stores/${user}/before-load.sql` });
    await settleRestore(env.DB, id, { state: 'failed' });
    expect((await listRestores(env.DB, user)).restores).toMatchObject([
      { kind: 'load', state: 'failed', appliedAt: null, dump: `stores/${user}/2026-10-05.sql`, before: `stores/${user}/before-load.sql`, undo: BOOKMARK },
    ]);
    // An undo of it is found by the same bookmark, as `LoadingStore`'s Undo sends it.
    expect(await undoneRow(env.DB, user, BOOKMARK)).toBe(id);
  });

  it('lists the newest first, says when there are more, and names an operator whose user row is gone by id', async () => {
    const user = account('many');
    for (let i = 0; i <= RESTORES_LISTED; i++) await startRestore(env.DB, { userId: user, operatorId: 'gone-operator', kind: 'moment', toAt: i });
    const { restores, more } = await listRestores(env.DB, user);
    expect(restores).toHaveLength(RESTORES_LISTED);
    expect(more).toBe(true);
    expect(restores[0]!.toAt).toBe(RESTORES_LISTED);
    expect(restores[0]!.operator).toEqual({ id: 'gone-operator', email: null });
  });

  it("goes with the account's directory row, and leaves every other account's", async () => {
    const user = account('dropped');
    const kept = account('kept');
    for (const id of [user, kept]) await startRestore(env.DB, { userId: id, operatorId: 'op', kind: 'moment', toAt: 1 });
    await dropRestoresStatement(env.DB, user).run();
    expect((await listRestores(env.DB, user)).restores).toEqual([]);
    expect((await listRestores(env.DB, kept)).restores).toHaveLength(1);
  });
});
