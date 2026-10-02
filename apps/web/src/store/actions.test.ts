import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollection, type Collection } from '@tanstack/db';
import type { FeedNote, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, NoteChangedError, OfflineError } from '../notes-api.js';
import { resetConnectivity } from '../connectivity.js';
import { seedFrom } from '../note-patch.js';
import * as actions from './actions.js';
import { createOutbox, provideLibrary, type WritableLibrary } from './actions.js';
import { lookups, toNote } from './derive.js';
import type { Collections, LocalNote } from './collections.js';
import type { FeedEngine } from './feed.js';

/**
 * The rules the outbox holds, against a stand-in for the executor that keeps the real
 * library's semantics where they matter here: a write is an optimistic TanStack DB
 * transaction whose commit settles only when its entry has been replayed, a `NonRetriableError`
 * ends an entry and rolls its change back, and a tab that does not hold the outbox's lock
 * gets a plain transaction that runs the write at once. What the library does with timers,
 * leader election and IndexedDB is its own; what this file tests is what we do with it.
 */

const h = vi.hoisted(async () => {
  const { createTransaction } = await import('@tanstack/db');

  class MemoryAdapter {
    db: null = null;
    rows = new Map<string, string>();
    constructor(readonly name: string) {}
    async get(key: string) {
      return this.rows.get(key) ?? null;
    }
    async set(key: string, value: string) {
      this.rows.set(key, value);
    }
    async delete(key: string) {
      this.rows.delete(key);
    }
    async keys() {
      return [...this.rows.keys()];
    }
    async clear() {
      this.rows.clear();
    }
  }

  interface Entry {
    id: string;
    mutationFnName: string;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }
  type Config = {
    storage: MemoryAdapter;
    mutationFns: Record<string, (p: { transaction: { id: string; mutations: unknown[]; metadata: Record<string, unknown> } }) => Promise<void>>;
    onLeadershipChange?: (leader: boolean) => void;
  };

  class FakeExecutor {
    enabled = true;
    queue: Entry[] = [];
    private settle = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
    constructor(readonly config: Config) {}
    get isOfflineEnabled() {
      return this.enabled;
    }
    /** A change of leadership, as the library reports one. */
    lead(leader: boolean) {
      this.enabled = leader;
      this.config.onLeadershipChange?.(leader);
    }
    async waitForInit() {}
    createOfflineTransaction({ mutationFnName, metadata, autoCommit }: { mutationFnName: string; metadata?: Record<string, unknown>; autoCommit?: boolean }) {
      const fn = this.config.mutationFns[mutationFnName]!;
      if (!this.enabled) {
        return createTransaction({ autoCommit: autoCommit ?? true, metadata, mutationFn: (params) => fn(params as never) });
      }
      const id = crypto.randomUUID();
      const done = new Promise<void>((resolve, reject) => this.settle.set(id, { resolve, reject }));
      void done.catch(() => {});
      const tx = createTransaction({
        id,
        autoCommit: false,
        metadata,
        mutationFn: async () => {
          const entry: Entry = { id, mutationFnName, metadata: metadata ?? {}, createdAt: new Date() };
          await this.config.storage.set(`tx:${id}`, JSON.stringify(entry));
          this.queue.push(entry);
          await done;
        },
      });
      return { id, mutate: (cb: () => void) => tx.mutate(cb), commit: () => tx.commit(), rollback: () => tx.rollback() };
    }
    async peekOutbox() {
      return this.queue.map((e) => ({ ...e }));
    }
    async removeFromOutbox(id: string) {
      await this.config.storage.delete(`tx:${id}`);
    }
    getPendingCount() {
      return this.queue.length;
    }
    async clearOutbox() {
      this.queue = [];
      await this.config.storage.clear();
    }
    dispose() {}
    /** Runs the head of the queue once, as the executor does when it can. */
    async replayOne(): Promise<'done' | 'refused' | 'kept' | 'empty'> {
      const e = this.queue[0];
      if (!e) return 'empty';
      try {
        await this.config.mutationFns[e.mutationFnName]!({ transaction: { id: e.id, mutations: [], metadata: e.metadata } });
      } catch (err) {
        if (err instanceof Error && err.name === 'NonRetriableError') {
          this.queue.shift();
          await this.config.storage.delete(`tx:${e.id}`);
          this.settle.get(e.id)?.reject(err);
          return 'refused';
        }
        return 'kept';
      }
      this.queue.shift();
      await this.config.storage.delete(`tx:${e.id}`);
      this.settle.get(e.id)?.resolve();
      return 'done';
    }
  }

  const fakes: FakeExecutor[] = [];
  return { fakes, FakeExecutor, MemoryAdapter };
});

vi.mock('@tanstack/offline-transactions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/offline-transactions')>();
  const { fakes, FakeExecutor, MemoryAdapter } = await h;
  return {
    ...real,
    IndexedDBAdapter: MemoryAdapter,
    startOfflineExecutor: (config: ConstructorParameters<typeof FakeExecutor>[0]) => {
      const f = new FakeExecutor(config);
      fakes.push(f);
      return f;
    },
  };
});

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  updateNote: vi.fn(),
  createNote: vi.fn(),
  duplicateNote: vi.fn(),
  deleteNote: vi.fn(),
  restoreNote: vi.fn(),
  deleteNotePermanently: vi.fn(),
  deleteNotes: vi.fn(),
  restoreNotes: vi.fn(),
  deleteNotesPermanently: vi.fn(),
  updateNotes: vi.fn(),
}));

const { fakes } = await h;

interface Controls<T extends object> {
  begin: () => void;
  write: (m: { type: 'insert' | 'update'; value: T } | { type: 'delete'; key: string }) => void;
  commit: () => unknown;
}

/** An in-memory collection with the sync controls a feed page would write through. */
function collection<T extends object>(seed: T[], keyOf: (row: T) => string): { c: Collection<T, string>; feed: Controls<T> } {
  let controls: Controls<T> | null = null;
  const c = createCollection<T, string>({
    id: `t-${Math.random().toString(36).slice(2)}`,
    getKey: keyOf,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        controls = { begin, write, commit } as Controls<T>;
        begin();
        for (const row of seed) write({ type: 'insert', value: row });
        commit();
        markReady();
      },
    },
  });
  return { c, feed: controls! };
}

const row = (id: string, over: Partial<FeedNote> = {}): LocalNote => ({ id, title: id, body: '', createdAt: 1, updatedAt: 100, tagIds: [], notebookId: null, files: [], ...over });

/** The server's copy as the feed would deliver it. */
const delivered = (lib: WritableLibrary, feed: Controls<LocalNote>, note: LocalNote) => {
  feed.begin();
  feed.write({ type: lib.notes.has(note.id) ? 'update' : 'insert', value: note });
  feed.commit();
};

function library(notes: LocalNote[]) {
  const n = collection(notes, (r) => r.id);
  const nb = collection<{ id: string }>([], (r) => r.id);
  const t = collection<{ id: string }>([], (r) => r.id);
  const a = collection<{ id: string }>([], (r) => r.id);
  const s = collection<{ id: string }>([], (r) => r.id);
  const collections = { notes: n.c, notebooks: nb.c, tags: t.c, attachments: a.c, syncState: s.c } as unknown as Collections;
  let release: (() => void) | null = null;
  const engine = {
    pull: vi.fn(() => new Promise<void>((r) => (release = r))),
  } as unknown as FeedEngine & { pull: ReturnType<typeof vi.fn> };
  const outbox = createOutbox('u1', { ...collections, userId: 'u1', engine });
  const lib: WritableLibrary = { ...collections, userId: 'u1', engine, outbox };
  provideLibrary(async () => lib);
  const fake = fakes[fakes.length - 1]!;
  return {
    lib,
    fake,
    feed: n.feed,
    engine,
    /** Lets a pull the actions are waiting on land. */
    landPull: () => release?.(),
    note: (id: string): Note => toNote(lib.notes.get(id)!, lookups({ notes: lib.notes.values(), notebooks: [], tags: [], attachments: [] })),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetConnectivity();
});

afterEach(() => {
  provideLibrary(async () => null);
  fakes.length = 0;
  vi.clearAllMocks();
});

describe('a replayed write', () => {
  it('keeps the row on what was written until the server’s copy has arrived', async () => {
    const { lib, fake, feed, engine, landPull, note } = library([row('n1', { title: 'old' })]);
    const base = note('n1');
    vi.mocked(api.updateNote).mockResolvedValue({ ...base, title: 'new', updatedAt: 101 });

    expect(await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base })).toBe('queued');
    await tick();
    expect(lib.notes.get('n1')?.title).toBe('new');
    expect(fake.queue).toHaveLength(1);

    const replay = fake.replayOne();
    await vi.waitFor(() => expect(engine.pull).toHaveBeenCalled());
    // The server has answered, the pull is in flight: the entry is still open, so the
    // optimistic row stands and nothing shows the copy from before the save.
    expect(fake.queue).toHaveLength(1);
    expect(lib.notes.get('n1')?.title).toBe('new');

    delivered(lib, feed, row('n1', { title: 'new', updatedAt: 101 }));
    landPull();
    expect(await replay).toBe('done');
    // The entry has ended and its optimistic change is dropped: what shows is the copy
    // the feed delivered, not the one from before the save.
    await tick();
    expect(lib.notes.get('n1')).toMatchObject({ title: 'new', updatedAt: 101 });
  });

  it('ends for good on any 4xx and is kept for a lost connection', async () => {
    const { fake } = library([row('n1'), row('n2')]);
    await actions.trashNotes(['n1']);
    await actions.trashNotes(['n2']);
    await tick();
    expect(fake.queue).toHaveLength(2);

    vi.mocked(api.deleteNotes).mockRejectedValueOnce(new OfflineError());
    expect(await fake.replayOne()).toBe('kept');
    expect(fake.queue).toHaveLength(2);

    vi.mocked(api.deleteNotes).mockRejectedValueOnce(new ApiError(403, 'Forbidden'));
    expect(await fake.replayOne()).toBe('refused');
    expect(fake.queue).toHaveLength(1);
    expect(fake.queue[0]?.metadata).toEqual({ ids: ['n2'] });
  });

  it('takes a note the server no longer has as done', async () => {
    const { fake, lib, landPull } = library([row('n1', { deletedAt: 5 })]);
    await actions.purgeNote('n1');
    await tick();
    expect(lib.notes.has('n1')).toBe(false);
    vi.mocked(api.deleteNotePermanently).mockRejectedValueOnce(new ApiError(404, 'Not found'));
    const replay = fake.replayOne();
    await tick();
    landPull();
    expect(await replay).toBe('done');
  });

  it('is refused as a conflict when the note moved on and the draft lacks what moved', async () => {
    const { fake, lib, landPull, note } = library([row('n1', { title: 'old', body: 'ours' })]);
    const base = note('n1');
    const theirs: Note = { ...base, body: 'theirs', updatedAt: 200 };
    vi.mocked(api.updateNote).mockRejectedValueOnce(new NoteChangedError(theirs));
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'mine' }, base });
    await tick();
    const replay = fake.replayOne();
    await tick();
    landPull();
    expect(await replay).toBe('refused');
    expect(lib.outbox.status().conflicts.get('n1')).toMatchObject({ updatedAt: 200 });
    expect(await fake.replayOne()).toBe('empty');
  });

  it('goes again against the newer copy when the draft already holds every change in it', async () => {
    const { fake, landPull, note } = library([row('n1', { title: 'old' })]);
    const base = note('n1');
    // Our own earlier save went through: the server holds the first title, and this draft
    // was made from the same base and carries that title too.
    const current: Note = { ...base, title: 'first', updatedAt: 150 };
    vi.mocked(api.updateNote).mockRejectedValueOnce(new NoteChangedError(current)).mockResolvedValueOnce({ ...current, title: 'first', updatedAt: 151 });
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'first' }, base });
    await tick();
    const replay = fake.replayOne();
    await tick();
    landPull();
    expect(await replay).toBe('done');
    expect(vi.mocked(api.updateNote).mock.calls.map((c) => c[1].ifUpdatedAt)).toEqual([100, 150]);
  });
});

describe('the no-library path', () => {
  it('does the request and answers with the server’s copy', async () => {
    provideLibrary(async () => null);
    const base: Note = { id: 'n1', title: 'old', body: '', tags: [], notebook: null, createdAt: 1, updatedAt: 100, fields: [] };
    vi.mocked(api.updateNote).mockResolvedValue({ ...base, title: 'new', updatedAt: 101 });
    const out = await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base });
    expect(out).toMatchObject({ title: 'new' });
    expect(api.updateNote).toHaveBeenCalledWith('n1', { title: 'new', ifUpdatedAt: 100 });
  });
});
