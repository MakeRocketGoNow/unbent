import { describe, expect, it } from 'vitest';
import { createCollection } from '@tanstack/db';
import { feedControls, type SyncHandles } from './collections.js';
import type { Controls } from './feed.js';

type Row = { id: string; title: string; deletedAt?: number };

/** A collection fed through `feedControls`, with every message it hands the collection kept. */
function fed() {
  const sent: unknown[] = [];
  let controls: Controls<Row> | null = null;
  const c = createCollection<Row, string>({
    id: `feed-controls-${Math.random().toString(36).slice(2)}`,
    getKey: (r) => r.id,
    startSync: true,
    sync: {
      rowUpdateMode: 'full',
      sync: (handles) => {
        const watched = { ...handles, write: (m: Parameters<SyncHandles<Row>['write']>[0]) => (sent.push(m), handles.write(m as never)) };
        controls = feedControls<Row>(watched as unknown as SyncHandles<Row>, (r) => r.id);
        handles.markReady();
      },
    },
  });
  const apply = (value: Row) => {
    controls!.begin();
    controls!.write({ type: controls!.has(value.id) ? 'update' : 'insert', value });
    controls!.commit();
  };
  return { c, sent, apply };
}

describe('feedControls', () => {
  /*
   * The persistence layer merges every sync write into the row in the file, so a key the
   * new row leaves out survives on disk unless the write names it. A restored note came
   * back from the file still trashed (2026-10-23).
   */
  it('names a key the held row had and the new one drops, so the stored row loses it too', () => {
    const { c, sent, apply } = fed();
    apply({ id: 'n', title: 'Gift card', deletedAt: 1 });
    apply({ id: 'n', title: 'Gift card' });

    const last = sent.at(-1) as { value: Row };
    expect('deletedAt' in last.value).toBe(true);
    expect(last.value.deletedAt).toBeUndefined();
    expect(JSON.parse(JSON.stringify(last.value))).toEqual({ id: 'n', title: 'Gift card' });
    expect(c.get('n')?.deletedAt).toBeUndefined();
  });

  it('leaves a first write as the feed sent it', () => {
    const { sent, apply } = fed();
    apply({ id: 'n', title: 'Gift card' });
    expect((sent.at(-1) as { value: Row }).value).toEqual({ id: 'n', title: 'Gift card' });
  });
});
