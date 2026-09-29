import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { sweepStores } from '@unbent/api/lib/sweep';
import { freshStore } from './helpers.js';

/**
 * The daily sweep, against real objects and a local D1 carrying the two control-plane
 * tables it reads: `user` and `account_directory`, created here in the shape migrations
 * 0002 and 0030 give them. What is checked is the sweep's one invariant and its three
 * jobs: a live account is woken and measured and never wiped; a tombstoned account, or
 * one whose user row is gone, is wiped and its row dropped once the object is empty;
 * and an account never opened gets its object created, and so its copy run.
 */

const stamp = Date.now();
const uid = (label: string) => `sweep-${label}-${stamp}`;

beforeAll(async () => {
  await env.DB.exec(
    [
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS account_directory (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, migrated_at INTEGER, storage_bytes INTEGER NOT NULL DEFAULT 0, note_count INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER, deleted_at INTEGER);`,
    ].join(' '),
  );
});

async function user(id: string) {
  await env.DB.prepare(`INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES (?1, 'T', ?2, 'now', 'now')`).bind(id, `${id}@example.test`).run();
}
async function directory(id: string, deletedAt: number | null = null) {
  await env.DB.prepare(`INSERT INTO account_directory (user_id, created_at, deleted_at) VALUES (?1, 1, ?2)`).bind(id, deletedAt).run();
}
async function row(id: string) {
  return env.DB.prepare(`SELECT * FROM account_directory WHERE user_id = ?1`).bind(id).first<{ note_count: number; storage_bytes: number; migrated_at: number | null }>();
}
const stub = (id: string) => env.USER_STORE.get(env.USER_STORE.idFromName(id));

describe('the store sweep', () => {
  it('measures the living, finishes the dead, and never wipes an account the directory says is alive', async () => {
    // A live account with notes in its object.
    const live = uid('live');
    await user(live);
    await directory(live);
    await stub(live).create({ id: crypto.randomUUID(), title: 'Mine', body: 'keep', tags: [] });
    await stub(live).create({ id: crypto.randomUUID(), title: 'Mine too', body: 'keep', tags: [] });

    // Deleted, with the wipe still to do: the tombstone is set and the object has rows.
    const tombstoned = uid('tombstoned');
    await user(tombstoned);
    await directory(tombstoned, Date.now());
    await stub(tombstoned).create({ id: crypto.randomUUID(), title: 'Gone', body: 'x', tags: [] });

    // A row whose user row is missing: the `afterDelete` hook never ran.
    const orphan = uid('orphan');
    await directory(orphan);
    await stub(orphan).create({ id: crypto.randomUUID(), title: 'Orphaned', body: 'x', tags: [] });

    // Never opened: no object exists until the sweep names it.
    const fresh = uid('fresh');
    await user(fresh);
    await directory(fresh);

    // Only this test's rows, so a store already holding directory rows from another run
    // does not make the counts below depend on it.
    const report = await sweepStores(env);
    expect(report.failed).toEqual([]);
    expect(report.visited).toBeGreaterThanOrEqual(4);
    expect(report.wiped).toBeGreaterThanOrEqual(2);

    expect(await row(live)).toMatchObject({ note_count: 2, migrated_at: expect.any(Number) });
    expect((await row(live))!.storage_bytes).toBeGreaterThan(0);
    expect((await stub(live).stats()).counts.notes).toBe(2);

    expect(await row(tombstoned)).toBeNull();
    expect((await stub(tombstoned).stats()).wiped).toBe(true);
    expect(await row(orphan)).toBeNull();
    expect((await stub(orphan).stats()).wiped).toBe(true);

    expect(await row(fresh)).toMatchObject({ note_count: 0, migrated_at: expect.any(Number) });
    const freshMeta = await runInDurableObject(stub(fresh), (_i, state) =>
      state.storage.sql.exec<{ key: string }>(`SELECT key FROM _meta WHERE key = 'migrated_from_d1'`).toArray(),
    );
    expect(freshMeta).toEqual([{ key: 'migrated_from_d1' }]);

    // Running again changes nothing for the living and finds nothing left of the dead.
    const again = await sweepStores(env);
    expect(again.failed).toEqual([]);
    expect((await stub(live).stats()).counts.notes).toBe(2);
    expect(await row(tombstoned)).toBeNull();
  });

  it('counts one account\'s failure and carries on to the next', async () => {
    const fine = uid('fine');
    await user(fine);
    await directory(fine);
    // An object that refuses to wake: its database claims another user.
    const broken = uid('broken');
    await user(broken);
    await directory(broken);
    const { stub: b } = { stub: stub(broken) };
    await b.ping();
    await runInDurableObject(b, (_i, state) => {
      state.storage.sql.exec(`UPDATE _meta SET value = 'someone-else' WHERE key = 'user_id'`);
    });
    const { evictDurableObject } = await import('cloudflare:test');
    await evictDurableObject(b);

    const report = await sweepStores(env);
    expect(report.failed).toContain(broken);
    expect(report.failed).not.toContain(fine);
    expect(await row(fine)).toMatchObject({ migrated_at: expect.any(Number) });
  });
});

// The helper is imported so this file, like every other, mints its own object names for
// anything it does not need a stable id for.
void freshStore;
