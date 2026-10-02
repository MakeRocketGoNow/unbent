import { createCollection, type Collection } from '@tanstack/db';
import type { FeedAttachment, FeedEntity, FeedNote, FeedNotebook, FeedTag } from '@unbent/shared';
import type { Cursor, FeedState } from './feed.js';
import { setLibraryForTests, type ReadableLibrary } from './library.js';

/**
 * An in-memory library for component tests: the four collections with no persistence
 * and no feed, seeded with rows, and a way to change them the way a feed page would —
 * through the collections' sync path, so a test that installs `installLibraryQueries`
 * sees the queries re-run. Installed as the library `queries.ts` reads until the test
 * uninstalls it.
 */

type Rows = {
  notes?: FeedNote[];
  notebooks?: FeedNotebook[];
  tags?: FeedTag[];
  attachments?: FeedAttachment[];
  /** The feed's cursor; `null` is a library that has never taken a snapshot. */
  cursor?: Cursor | null;
};

interface Controls<T extends object> {
  begin: () => void;
  write: (m: { type: 'insert' | 'update'; value: T } | { type: 'delete'; key: string }) => void;
  commit: () => unknown;
}

export interface TestLibrary extends ReadableLibrary {
  /** Puts a row in, as a feed page would. */
  upsert: (entity: FeedEntity, row: FeedNote | FeedNotebook | FeedTag | FeedAttachment) => void;
  remove: (entity: FeedEntity, id: string) => void;
  uninstall: () => void;
}

export function installTestLibrary(rows: Rows = {}): TestLibrary {
  const controls = new Map<FeedEntity, Controls<object>>();
  const make = <T extends object>(id: FeedEntity, seed: T[], keyOf: (row: T) => string): Collection<T, string> =>
    createCollection<T, string>({
      id: `test-${id}-${Math.random().toString(36).slice(2)}`,
      getKey: keyOf,
      startSync: true,
      sync: {
        sync: ({ begin, write, commit, markReady }) => {
          controls.set(id, { begin, write, commit } as Controls<object>);
          begin();
          for (const row of seed) write({ type: 'insert', value: row });
          commit();
          markReady();
        },
      },
    });
  const lib = {
    notes: make<FeedNote>('note', rows.notes ?? [], (n) => n.id),
    notebooks: make<FeedNotebook>('notebook', rows.notebooks ?? [], (n) => n.id),
    tags: make<FeedTag>('tag', rows.tags ?? [], (t) => t.id),
    attachments: make<FeedAttachment>('attachment', rows.attachments ?? [], (a) => a.id),
  };
  const cursor = rows.cursor === undefined ? { seq: 1, epoch: 'test' } : rows.cursor;
  const state: FeedState = { phase: cursor ? 'current' : 'starting', cursor, lastError: null, total: null, applied: 0, pulls: 1 };
  const of = (entity: FeedEntity) => ({ note: lib.notes, notebook: lib.notebooks, tag: lib.tags, attachment: lib.attachments })[entity] as Collection<object, string>;
  const test: TestLibrary = {
    ...lib,
    state: () => state,
    upsert: (entity, row) => {
      const c = controls.get(entity)!;
      c.begin();
      c.write({ type: of(entity).has((row as { id: string }).id) ? 'update' : 'insert', value: row });
      c.commit();
    },
    remove: (entity, id) => {
      const c = controls.get(entity)!;
      c.begin();
      c.write({ type: 'delete', key: id });
      c.commit();
    },
    uninstall: () => setLibraryForTests(null),
  };
  setLibraryForTests(test);
  return test;
}
