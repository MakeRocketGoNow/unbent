import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  type BrowserWASQLiteDatabase,
} from '@tanstack/browser-db-sqlite-persistence';
import { storeFileName } from './names.js';

/**
 * One account's local copy of its library: a SQLite file in the browser's origin-private
 * file system, opened through TanStack DB's browser adapter, which runs the engine in a
 * worker and persists collections into it.
 *
 * Opened once per account and held for as long as the account is signed in here. A
 * second account opening its store closes the first's: the file is per account, so the
 * two never share rows, but the worker and its access handles are one set, and holding
 * two open at once is not something the adapter promises. After a page returns from the
 * back/forward cache the adapter wants fresh instances, which `closeLocalStore` followed
 * by `openLocalStore` gives it.
 *
 * `coordinator` is what lets two tabs of one account share the file: it elects an owner
 * per collection and routes the other tab's writes through it. Without it each tab
 * would open the file alone and the second would wait on the first's access handles.
 */
export interface LocalStore {
  userId: string;
  database: BrowserWASQLiteDatabase;
  persistence: ReturnType<typeof createBrowserWASQLitePersistence>;
  coordinator: BrowserCollectionCoordinator;
}

let current: { userId: string; store: Promise<LocalStore> } | null = null;

export function openLocalStore(userId: string): Promise<LocalStore> {
  if (current?.userId === userId) return current.store;
  const previous = current;
  const store = (async () => {
    if (previous) await closeStore(previous.store);
    const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: storeFileName(userId) });
    const coordinator = new BrowserCollectionCoordinator({ dbName: storeFileName(userId) });
    const persistence = createBrowserWASQLitePersistence({ database, coordinator });
    return { userId, database, persistence, coordinator };
  })();
  current = { userId, store };
  return store;
}

/** The store open now, if any, without opening one. */
export function currentLocalStore(): Promise<LocalStore> | null {
  return current?.store ?? null;
}

async function closeStore(store: Promise<LocalStore>): Promise<void> {
  let s: LocalStore;
  try {
    s = await store;
  } catch {
    return;
  }
  s.coordinator.dispose?.();
  await s.database.close?.();
}

/** Closes the open store, if any. Collections built on it must be cleaned up first. */
export async function closeLocalStore(): Promise<void> {
  const open = current;
  current = null;
  if (open) await closeStore(open.store);
}
