import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Feed } from '@unbent/api/store/feed';
import { PRUNE_BATCH, RETAIN_MS, RETAIN_ROWS } from '@unbent/api/store/feed';
import { freshStore } from './helpers.js';

/**
 * The change feed's writer, against the real table: what one `record` costs on the
 * rows-read and rows-written budget, and what retention does per write. The numbers
 * bounded here are the ones measured in the dry run of 2026-10-02 (the plan's assumptions
 * table); a change that moves them is a change to what every write on every account
 * costs, and should be a decision.
 *
 * `Feed` is the object's, not an RPC method, so these reach it through the instance; the
 * writes that call it are tested through the surface in notes-store.test.ts and
 * attachments-store.test.ts.
 */

const DAY = 24 * 60 * 60 * 1000;

const feedOf = (instance: unknown) => (instance as { feed: Feed }).feed;

describe('the change feed', () => {
  it('numbers rows from _meta.seq, one per entity, last word per entity', async () => {
    const { stub } = freshStore('feed-record');
    await stub.ping();
    const out = await runInDurableObject(stub, (instance, state) => {
      const feed = feedOf(instance);
      const first = state.storage.transactionSync(() =>
        feed.record([
          { entity: 'note', id: 'n1' },
          { entity: 'tag', id: 't1' },
          { entity: 'note', id: 'n1', deleted: true },
        ]),
      );
      const second = state.storage.transactionSync(() => feed.record([{ entity: 'notebook', id: 'nb1' }]));
      const nothing = state.storage.transactionSync(() => feed.record([]));
      const rows = state.storage.sql.exec(`SELECT seq, entity, id, deleted FROM changes ORDER BY seq`).toArray();
      return { first, second, nothing, rows, seq: feed.seq(), epoch: feed.epoch(), announce: feed.takeAnnouncement(), again: feed.takeAnnouncement() };
    });
    expect(out.first).toBe(2);
    expect(out.second).toBe(3);
    expect(out.nothing).toBeNull();
    expect(out.rows).toEqual([
      { seq: 1, entity: 'note', id: 'n1', deleted: 1 },
      { seq: 2, entity: 'tag', id: 't1', deleted: 0 },
      { seq: 3, entity: 'notebook', id: 'nb1', deleted: 0 },
    ]);
    expect(out.seq).toBe(3);
    expect(out.epoch).toMatch(/^[0-9a-f]{32}$/);
    // The announcement is the newest seq, and is handed out once.
    expect(out.announce).toBe(3);
    expect(out.again).toBeNull();
  });

  it('costs one row written per change and one per transaction, and prunes nothing below the cap', async () => {
    const { stub } = freshStore('feed-cost');
    await stub.ping();
    await stub.resetCounters();
    await runInDurableObject(stub, (instance, state) => {
      const feed = feedOf(instance);
      state.storage.transactionSync(() => feed.record([{ entity: 'note', id: 'a' }, { entity: 'note', id: 'b' }, { entity: 'note', id: 'c' }]));
    });
    const { rowsWritten, rowsRead } = await stub.counters();
    // Three rows, the counter's upsert, and nothing else: the count-cap delete reads no
    // rows below the cap and the age check reads the oldest row once.
    expect(rowsWritten).toBe(4);
    expect(rowsRead).toBeLessThanOrEqual(6);
  });

  it('keeps the last fifty thousand rows, one deleted per write at the cap', async () => {
    const { stub } = freshStore('feed-cap');
    await stub.ping();
    const now = Date.now();
    await runInDurableObject(stub, (instance, state) => {
      const feed = feedOf(instance);
      // Filled in pages, as an archive-sized import would fill it.
      for (let start = 0; start < RETAIN_ROWS - 1; start += 1000) {
        state.storage.transactionSync(() => {
          const page = [];
          for (let i = start; i < Math.min(RETAIN_ROWS - 1, start + 1000); i++) page.push({ entity: 'note' as const, id: `n${i}` });
          feed.record(page, now);
        });
      }
    });
    const count = () => runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ n: number; oldest: number }>(`SELECT COUNT(*) AS n, MIN(seq) AS oldest FROM changes`).toArray()[0]!);
    expect(await count()).toEqual({ n: RETAIN_ROWS - 1, oldest: 1 });

    await stub.resetCounters();
    await runInDurableObject(stub, (instance, state) => state.storage.transactionSync(() => feedOf(instance).record([{ entity: 'note', id: 'x' }], now)));
    const below = await stub.counters();
    expect(await count()).toEqual({ n: RETAIN_ROWS, oldest: 1 });

    await stub.resetCounters();
    await runInDurableObject(stub, (instance, state) => state.storage.transactionSync(() => feedOf(instance).record([{ entity: 'note', id: 'y' }], now)));
    const atCap = await stub.counters();
    expect(await count()).toEqual({ n: RETAIN_ROWS, oldest: 2 });

    // At the cap one write deletes one row: one more written, two more read (the range
    // finds the row, the delete reads it) than a write below it.
    expect(atCap.rowsWritten).toBe(below.rowsWritten + 1);
    expect(atCap.rowsRead).toBeLessThanOrEqual(below.rowsRead + 2);
  });

  it('drops rows past ninety days a batch at a time, then costs the steady state again', async () => {
    const { stub } = freshStore('feed-age');
    await stub.ping();
    const now = Date.now();
    await runInDurableObject(stub, (instance, state) => {
      const feed = feedOf(instance);
      state.storage.transactionSync(() => {
        const old = [];
        for (let i = 0; i < 2 * PRUNE_BATCH; i++) old.push({ entity: 'note' as const, id: `old${i}` });
        feed.record(old, now - RETAIN_MS - 10 * DAY);
      });
      state.storage.transactionSync(() => feed.record([{ entity: 'note', id: 'recent' }], now - DAY));
    });
    const count = () => runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ n: number; oldest: number }>(`SELECT COUNT(*) AS n, MIN(seq) AS oldest FROM changes`).toArray()[0]!);
    // The write that recorded `recent` already took the first batch with it.
    expect(await count()).toEqual({ n: PRUNE_BATCH + 1, oldest: PRUNE_BATCH + 1 });

    await stub.resetCounters();
    await runInDurableObject(stub, (instance, state) => state.storage.transactionSync(() => feedOf(instance).record([{ entity: 'note', id: 'w1' }], now)));
    const pruning = await stub.counters();
    expect(await count()).toEqual({ n: 2, oldest: 2 * PRUNE_BATCH + 1 });
    // A batch: the rows it deletes, read and written once each, and the write's own.
    expect(pruning.rowsWritten).toBeLessThanOrEqual(PRUNE_BATCH + 2);
    expect(pruning.rowsRead).toBeLessThanOrEqual(PRUNE_BATCH + 6);

    await stub.resetCounters();
    await runInDurableObject(stub, (instance, state) => state.storage.transactionSync(() => feedOf(instance).record([{ entity: 'note', id: 'w2' }], now)));
    const steady = await stub.counters();
    expect(steady.rowsWritten).toBe(2);
    expect(steady.rowsRead).toBeLessThanOrEqual(4);
  });
});
