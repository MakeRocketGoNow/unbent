import { createCollection, type Collection } from '@tanstack/db';
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';
import type { FeedAttachment, FeedEntity, FeedNote, FeedNotebook, FeedTag } from '@unbent/shared';
import { FeedEngine, type Controls, type FeedOptions, type Position } from './feed.js';
import type { LocalStore } from './db.js';

/**
 * The four collections one account's library is made of, persisted into its local store
 * and kept current by the feed engine. Their rows are the feed's shapes (a note by its
 * `tagIds` and `notebookId`, a notebook with its definitions, a tag, a file) and the
 * list rows, counts and names the components read are derived from them in `queries.ts`.
 *
 * `syncState` is a fifth, local-only collection with one row: the feed's cursor and the
 * epoch it belongs to, and while the first copy is under way, the snapshot page to resume
 * from. In the same file as the rows, and written only once a page's commits have settled
 * (the engine awaits them, since each collection persists on a queue of its own and this
 * one's write would otherwise overtake a notes commit still queued) so a page cut short
 * by a closed tab is applied again rather than skipped; every apply is an upsert.
 */
/**
 * A note as the collection holds it: the feed's row, plus two things a write made here
 * carries until the server has heard of it. A note filed into a notebook that does not
 * exist yet, or tagged with a tag nobody has used, has no id for either (the server
 * mints both) so the optimistic row names them (`notebookName`, `tagNames`), the
 * derivations read those first, and the row the feed delivers after the replay, with
 * ids, replaces it.
 */
export interface LocalNote extends FeedNote {
  notebookName?: string | null;
  tagNames?: string[];
}

/**
 * A file as the collection holds it: the feed's row, or one made here for a file added
 * with no connection, which says so (`pending`) until its upload has gone through and the
 * feed delivers the row under the same id. Its bytes are on the account's `pending` shelf
 * (`store/files.ts`) meanwhile, where the service worker finds them by the file's address.
 */
export interface LocalAttachment extends FeedAttachment {
  pending?: true;
}

export interface Collections {
  notes: Collection<LocalNote, string>;
  notebooks: Collection<FeedNotebook, string>;
  tags: Collection<FeedTag, string>;
  attachments: Collection<LocalAttachment, string>;
  syncState: Collection<SyncState, string>;
}

interface SyncState extends Position {
  id: 'cursor';
}

/** The stored row format; bump when a row's shape changes and the wrapper resets the rows, which the feed then reloads. */
const SCHEMA_VERSION = 1;

export function createCollections(store: LocalStore, engine: FeedEngine): Collections {
  const fed = <T extends object>(id: string, entity: FeedEntity, keyOf: (row: T) => string) =>
    createCollection(
      persistedCollectionOptions<T, string>({
        id,
        getKey: keyOf,
        persistence: store.persistence,
        schemaVersion: SCHEMA_VERSION,
        // Rows from persistence render before the first pull answers; see `FeedEngine`.
        initialRender: { strategy: 'network-first', networkTimeoutMs: 0 },
        sync: {
          rowUpdateMode: 'full',
          sync: (handles) => engine.register(entity, feedControls<T>(handles) as never),
        },
      }),
    );

  const syncState = createCollection(
    persistedCollectionOptions<SyncState, string>({
      id: 'sync-state',
      getKey: (row) => row.id,
      persistence: store.persistence,
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  return {
    notes: fed<LocalNote>('notes', 'note', (n) => n.id),
    notebooks: fed<FeedNotebook>('notebooks', 'notebook', (n) => n.id),
    tags: fed<FeedTag>('tags', 'tag', (t) => t.id),
    attachments: fed<LocalAttachment>('attachments', 'attachment', (a) => a.id),
    syncState,
  };
}

/** What TanStack DB hands a collection's sync function, as far as the engine needs it. */
export interface SyncHandles<T extends object> {
  collection: { has: (key: string) => boolean; values: () => Iterable<T> };
  begin: (options?: { immediate?: boolean }) => void;
  write: (message: { type: 'insert' | 'update'; value: T } | { type: 'delete'; key: string }) => void;
  commit: () => unknown;
  truncate: () => void;
  markReady: () => void;
}

/**
 * A collection's sync handles as the engine's controls; the tests feed collections through
 * this too.
 *
 * Every transaction begins `immediate`. By default TanStack DB holds a committed page of
 * sync back while any write on the collection is in flight, and applies it once none is.
 * Every entry waiting in the outbox is such a write, from the moment it is queued until
 * its replay ends, and a replay ends only after the pull that brings its own row back has
 * applied (`settled` in `actions.ts`), which since the engine began waiting for each
 * page's commit is a wait on that held page. A single trash waited on itself; a second
 * queued behind it waited for good, and only a reload ended it, by sending the first
 * again (seen on 2026-10-08, where a restore made in between was undone). Offline it is
 * worse in a quieter way: a write waiting all afternoon would hold every page another
 * device's edits arrive in.
 *
 * A page is the server's copy and goes in when it arrives; an entry's optimistic change
 * stays drawn over it until the entry ends, so nothing the person typed is hidden by it,
 * and once the entry ends the row is the server's copy with no gap between. Applied at
 * once, the commit settles at once, so the persistence layer never has a page waiting
 * for the collection, which is also what keeps its rule against an immediate page
 * overtaking a waiting one from refusing these.
 *
 * `has` and `values` answer from the rows the feed wrote, not the collection's view of
 * them. The engine asks what the server's copy here holds (whether a tombstone has a row
 * to delete, which files a note had) and the view answers with the outbox's changes
 * drawn on top. A purge hides its note from the view, and the purge's own pull brings the
 * note's tombstone: asked of the view, the row was not there, the tombstone was dropped,
 * the cursor moved past it, and the note was back in the trash once the purge ended, for
 * good, since the feed never names it again (seen on 2026-10-08). Read through the
 * collection's state manager, as `syncedRow` in `actions.ts` reads it; the version is
 * pinned (`pins.test.ts`), and without the field the view is the fallback.
 */
export function feedControls<T extends object>({ collection, begin, write, commit, truncate, markReady }: SyncHandles<T>): Controls<T> {
  const synced = () => (collection as unknown as { _state?: { syncedData?: { has: (key: string) => boolean; values: () => Iterable<T> } } })._state?.syncedData ?? collection;
  return {
    begin: () => begin({ immediate: true }),
    write: (m) => write(m.type === 'delete' ? { type: 'delete', key: m.key } : { type: m.type, value: m.value }),
    commit: () => commit(),
    truncate,
    markReady,
    has: (key) => synced().has(key),
    values: () => synced().values(),
  };
}

/** The engine's cursor store, on the `syncState` collection. */
export function cursorStore(syncState: Collection<SyncState, string>): Pick<FeedOptions, 'readCursor' | 'writeCursor'> {
  return {
    readCursor: async () => {
      await syncState.preload();
      const row = syncState.get('cursor');
      return row ? { seq: row.seq, epoch: row.epoch, resume: row.resume ?? null, total: row.total ?? null } : null;
    },
    writeCursor: async (position) => {
      const tx = position
        ? syncState.has('cursor')
          ? syncState.update('cursor', (draft) => {
              draft.seq = position.seq;
              draft.epoch = position.epoch;
              draft.resume = position.resume ?? null;
              draft.total = position.total ?? null;
            })
          : syncState.insert({ id: 'cursor', seq: position.seq, epoch: position.epoch, resume: position.resume ?? null, total: position.total ?? null })
        : syncState.has('cursor')
          ? syncState.delete('cursor')
          : null;
      if (tx) await tx.isPersisted.promise;
    },
  };
}
