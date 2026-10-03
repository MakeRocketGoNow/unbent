import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeLocalStores, wipeLocalStores } from './wipe.js';

vi.mock('./library.js', () => ({ closeLibrary: vi.fn(async () => {}), currentLibraryUser: vi.fn(() => null) }));
vi.mock('./db.js', () => ({ closeLocalStore: vi.fn(async () => {}) }));
import { closeLibrary, currentLibraryUser } from './library.js';

/**
 * What the wipe removes, against a stand-in file system and IndexedDB: every account's
 * copy, outbox and files, or every account's but the one named — whose database, its
 * journal and WAL beside it, its files directory and its outbox stay, since the outbox may hold writes the server has
 * not heard of. The engine's own directory is never ours to remove.
 */
function device(files: string[], dbs: string[]) {
  const removed: string[] = [];
  const deleted: string[] = [];
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        entries: async function* () {
          for (const f of files) yield [f, {}];
        },
        removeEntry: async (name: string) => void removed.push(name),
      }),
    },
  });
  vi.stubGlobal('indexedDB', {
    databases: async () => dbs.map((name) => ({ name })),
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const req = {} as { onsuccess?: () => void };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  });
  return { removed, deleted };
}

const files = ['unbent-a.sqlite', 'unbent-a.sqlite-wal', 'unbent-a.sqlite-journal', 'unbent-b.sqlite', 'unbent-files-a', 'unbent-files-b', '.ahp-pigei0c7inp'];
const dbs = ['unbent-outbox-a', 'unbent-outbox-b', 'offline-transactions'];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('wipeLocalStores', () => {
  it('removes every account’s copy and outbox, after closing the open library', async () => {
    const { removed, deleted } = device(files, dbs);
    await wipeLocalStores();
    expect(removed.sort()).toEqual(['unbent-a.sqlite', 'unbent-a.sqlite-journal', 'unbent-a.sqlite-wal', 'unbent-b.sqlite', 'unbent-files-a', 'unbent-files-b']);
    expect(deleted.sort()).toEqual(['unbent-outbox-a', 'unbent-outbox-b']);
    expect(closeLibrary).toHaveBeenCalled();
  });

  it('keeps the named account’s files and outbox, and their open library', async () => {
    const { removed, deleted } = device(files, dbs);
    vi.mocked(currentLibraryUser).mockReturnValue('a');
    await wipeLocalStores('a');
    expect(removed.sort()).toEqual(['unbent-b.sqlite', 'unbent-files-b']);
    expect(deleted).toEqual(['unbent-outbox-b']);
    expect(closeLibrary).not.toHaveBeenCalled();
  });

  it('closes another account’s open library before keeping the named one’s files', async () => {
    device(files, dbs);
    vi.mocked(currentLibraryUser).mockReturnValue('b');
    await wipeLocalStores('a');
    expect(closeLibrary).toHaveBeenCalled();
  });
});

describe('closeLocalStores', () => {
  it('closes and removes nothing', async () => {
    const { removed, deleted } = device(files, dbs);
    await closeLocalStores();
    expect(closeLibrary).toHaveBeenCalled();
    expect(removed).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
