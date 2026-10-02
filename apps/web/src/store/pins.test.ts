import { describe, expect, it } from 'vitest';
import { createCollection } from '@tanstack/db';
import { IndexedDBAdapter, OfflineExecutor } from '@tanstack/offline-transactions';
import pkg from '../../package.json';

/**
 * Two private fields of two libraries are reached into: `syncedRow` in `actions.ts` reads
 * a collection's `_state.syncedData` for the row as the server last had it, and the
 * outbox's `dispose` closes the IndexedDB adapter's `db`. Neither is part of a contract,
 * so the versions are pinned exactly and this says so the day an upgrade moves them —
 * rather than the base of a save quietly becoming the local, unsynced view.
 */
describe('the pinned library internals', () => {
  it('are pinned exactly', () => {
    expect(pkg.dependencies['@tanstack/db']).toMatch(/^\d/);
    expect(pkg.dependencies['@tanstack/offline-transactions']).toMatch(/^\d/);
  });

  it('a collection exposes the synced rows under _state.syncedData', () => {
    const c = createCollection<{ id: string }, string>({
      id: 'pins',
      getKey: (r) => r.id,
      startSync: true,
      sync: {
        sync: ({ begin, write, commit, markReady }) => {
          begin();
          write({ type: 'insert', value: { id: 'a' } });
          commit();
          markReady();
        },
      },
    });
    const state = (c as unknown as { _state?: { syncedData?: Map<string, unknown> } })._state;
    expect(state?.syncedData?.get('a')).toEqual({ id: 'a' });
  });

  it('the IndexedDB adapter keeps its connection under db', () => {
    expect('db' in new IndexedDBAdapter('pins')).toBe(true);
  });

  it('the executor can roll a restored entry’s change back through cleanupRestorationTransaction', () => {
    expect(typeof (OfflineExecutor.prototype as unknown as Record<string, unknown>).cleanupRestorationTransaction).toBe('function');
  });
});
