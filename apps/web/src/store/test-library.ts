import { createCollection, type Collection } from '@tanstack/db';
import type { FeedAttachment, FeedEntity, FeedNote, FeedNotebook, FeedTag, FeedView } from '@unbent/shared';
import type { Cursor, FeedState } from './feed.js';
import { setLibraryForTests, type ReadableLibrary, notifyLibraryChange, notifyLibraryReset } from './library.js';
import { LIBRARY_ROOTS, VIEW_ROOTS, rootsOfNoteChanges } from './library-roots.js';

/**
 * An in-memory library for component tests: the five collections with no persistence
 * and no feed, seeded with rows, and a way to change them the way a feed page would:
 * through the collections' sync path, and told to the query bridge as the real library
 * tells it (`open` in `library.ts`: the same roots, the same subscription options, one
 * call per task), so a test that installs `installLibraryQueries` sees the queries re-run.
 * Installed as the library `queries.ts` reads until the test uninstalls it.
 */

type Rows = {
  notes?: FeedNote[];
  notebooks?: FeedNotebook[];
  tags?: FeedTag[];
  attachments?: FeedAttachment[];
  views?: FeedView[];
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
  upsert: (entity: FeedEntity, row: FeedNote | FeedNotebook | FeedTag | FeedAttachment | FeedView) => void;
  remove: (entity: FeedEntity, id: string) => void;
  subscribe: (listener: (state: FeedState) => void) => () => void;
  /** The engine's `reset`: the count moves, the library is not whole until `settle`, and every subscriber hears it; the rows are the caller's to replace. */
  reset: () => void;
  /** The walk after a reset finishing: the library is whole again. */
  settle: () => void;
  /** Whether the views are whole (`FeedState.views`): a copy made before views, until it is filled. */
  viewsWhole: (whole: boolean) => void;
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
    views: make<FeedView>('view', rows.views ?? [], (v) => v.id),
  };
  const cursor = rows.cursor === undefined ? { seq: 1, epoch: 'test' } : rows.cursor;
  // Views are whole whenever the copy is: a test that wants otherwise sets `state.views`.
  const state: FeedState = { phase: cursor ? 'current' : 'starting', cursor, lastError: null, total: null, applied: 0, pulls: 1, resets: 0, views: cursor !== null };
  const listeners = new Set<(s: FeedState) => void>();
  const of = (entity: FeedEntity) => ({ note: lib.notes, notebook: lib.notebooks, tag: lib.tags, attachment: lib.attachments, view: lib.views })[entity] as Collection<object, string>;
  let version = 0;
  // Told to the bridge as the real library tells it (`changed` in `library.ts`): the
  // roots a task's changes reach, in one call on a microtask, so a test sees one
  // invalidation per write and never one in the middle of it. The subscription option
  // is explicit for the same reason as there: unset, a subscription drops the removal of
  // a row it has not emitted (every seeded row, here) and the holder's bug would not show.
  let touched = new Set<string>();
  const changed = (roots: ReadonlySet<string>) => {
    const first = touched.size === 0;
    for (const r of roots) touched.add(r);
    if (!first) return;
    queueMicrotask(() => {
      const reached = touched;
      touched = new Set();
      notifyLibraryChange(reached);
    });
  };
  const every = { includeInitialState: false } as const;
  const subscriptions = [
    lib.notes.subscribeChanges((changes) => changed(rootsOfNoteChanges(changes)), every),
    lib.notebooks.subscribeChanges(() => changed(LIBRARY_ROOTS), every),
    lib.tags.subscribeChanges(() => changed(LIBRARY_ROOTS), every),
    lib.attachments.subscribeChanges(() => changed(LIBRARY_ROOTS), every),
    lib.views.subscribeChanges(() => changed(VIEW_ROOTS), every),
  ];
  const test: TestLibrary = {
    ...lib,
    state: () => state,
    // The real library's, for `useFeedState`: without it the test library reads as one that
    // keeps no feed, and nothing that waits for a whole library (`useLibraryWhole`) would
    // ever see one. The state moves only when a test calls `reset`.
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reset: () => {
      state.resets += 1;
      state.phase = 'reset';
      listeners.forEach((l) => l({ ...state }));
      // As the real library: the state moves as the emptying begins, and the query
      // bridge drops the answers nobody is watching once the rows are gone.
      notifyLibraryReset();
    },
    settle: () => {
      state.phase = 'current';
      listeners.forEach((l) => l({ ...state }));
    },
    viewsWhole: (whole) => {
      state.views = whole;
      listeners.forEach((l) => l({ ...state }));
    },
    version: () => version,
    upsert: (entity, row) => {
      const c = controls.get(entity)!;
      c.begin();
      c.write({ type: of(entity).has((row as { id: string }).id) ? 'update' : 'insert', value: row });
      c.commit();
      version += 1;
    },
    remove: (entity, id) => {
      const c = controls.get(entity)!;
      c.begin();
      c.write({ type: 'delete', key: id });
      c.commit();
      version += 1;
    },
    uninstall: () => {
      subscriptions.forEach((s) => s.unsubscribe());
      setLibraryForTests(null);
    },
  };
  setLibraryForTests(test);
  return test;
}
