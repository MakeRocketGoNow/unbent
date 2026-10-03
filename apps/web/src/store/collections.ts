import { createCollection, type Collection } from '@tanstack/db';
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';
import type { FeedAttachment, FeedEntity, FeedNote, FeedNotebook, FeedTag } from '@unbent/shared';
import { FeedEngine, type Controls, type FeedOptions, type Position } from './feed.js';
import type { LocalStore } from './db.js';

/**
 * The four collections one account's library is made of, persisted into its local store
 * and kept current by the feed engine. Their rows are the feed's shapes — a note by its
 * `tagIds` and `notebookId`, a notebook with its definitions, a tag, a file — and the
 * list rows, counts and names the components read are derived from them in `queries.ts`.
 *
 * `syncState` is a fifth, local-only collection with one row: the feed's cursor and the
 * epoch it belongs to, and while the first copy is under way, the snapshot page to resume
 * from. In the same file as the rows, written after a page's rows have been committed, so
 * a page cut short by a closed tab is applied again rather than skipped; every apply is
 * an upsert.
 */
/**
 * A note as the collection holds it: the feed's row, plus two things a write made here
 * carries until the server has heard of it. A note filed into a notebook that does not
 * exist yet, or tagged with a tag nobody has used, has no id for either — the server
 * mints both — so the optimistic row names them (`notebookName`, `tagNames`), the
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
          sync: ({ collection, begin, write, commit, truncate, markReady }) => {
            const controls: Controls<T> = {
              begin: () => begin(),
              write: (m) => write(m.type === 'delete' ? { type: 'delete', key: m.key } : { type: m.type, value: m.value }),
              commit: () => commit(),
              truncate,
              markReady,
              has: (key) => collection.has(key),
              values: () => collection.values(),
            };
            return engine.register(entity, controls as never);
          },
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
