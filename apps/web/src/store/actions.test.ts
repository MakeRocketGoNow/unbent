import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollection, type Collection } from '@tanstack/db';
import { QueryClient } from '@tanstack/react-query';
import type { FeedNote, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, NoteChangedError, OfflineError } from '../notes-api.js';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { seedFrom } from '../note-patch.js';
import { installLibraryQueries, keys } from '../queries.js';
import * as actions from './actions.js';
import { createOutbox, provideLibrary, type WritableLibrary } from './actions.js';
import { lookups, toNote } from './derive.js';
import type { Collections, LocalNote } from './collections.js';
import type { FeedEngine } from './feed.js';
import { installMemoryOpfs, type MemoryDirectory } from './test-opfs.js';

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

  /** IndexedDB as the executor uses it: a database per name that outlives the adapter object. */
  const databases = new Map<string, Map<string, string>>();
  class MemoryAdapter {
    static databases = databases;
    db: null = null;
    rows: Map<string, string>;
    constructor(readonly name: string) {
      this.rows = databases.get(name) ?? new Map();
      databases.set(name, this.rows);
    }
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

// The cache of opened files keeps nothing over twenty megabytes; twelve bytes here, so a
// test can be on either side of it without making a file that size.
vi.mock('../sw/routes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sw/routes.js')>()),
  MAX_KEPT_FILE: 12,
}));

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
  uploadFile: vi.fn(),
  deleteAttachment: vi.fn(),
  restoreRevision: vi.fn(),
  clearRevisions: vi.fn(),
}));

const { fakes, MemoryAdapter } = await h;

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
    // A whole copy unless a test says the first one is still walking.
    state: { phase: 'current', cursor: { seq: 1, epoch: 'test' } as { seq: number; epoch: string } | null },
    pull: vi.fn(() => new Promise<void>((r) => (release = r))),
    // The server's answer, written in as a feed row would be.
    applyNotes: vi.fn((rows: LocalNote[]) => {
      for (const r of rows) delivered({ notes: n.c } as never, n.feed, r);
      return true;
    }),
  } as unknown as FeedEngine & { pull: ReturnType<typeof vi.fn>; applyNotes: ReturnType<typeof vi.fn>; state: { phase: string; cursor: { seq: number; epoch: string } | null } };
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
  MemoryAdapter.databases.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('a replayed write', () => {
  it('writes the server’s copy into the row before its entry ends, with no pull', async () => {
    const { lib, fake, engine, note } = library([row('n1', { title: 'old' })]);
    const base = note('n1');
    vi.mocked(api.updateNote).mockResolvedValue({ ...base, title: 'new', updatedAt: 101 });

    expect(await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base })).toBe('queued');
    await tick();
    expect(lib.notes.get('n1')?.title).toBe('new');
    expect(fake.queue).toHaveLength(1);

    expect(await fake.replayOne()).toBe('done');
    await tick();
    // The entry has ended and its optimistic change is dropped: what shows is the copy
    // the server answered with, written in as a feed row, not the one from before the
    // save — and nothing was asked of the server for it.
    expect(lib.notes.get('n1')).toMatchObject({ title: 'new', updatedAt: 101 });
    expect(engine.applyNotes).toHaveBeenCalledWith([expect.objectContaining({ id: 'n1', title: 'new', updatedAt: 101, tagIds: [], notebookId: null })]);
    expect(engine.pull).not.toHaveBeenCalled();
  });

  it('keeps the row on what was written until a pull has brought the copy, when the answer names what this device has no id for', async () => {
    const { lib, fake, feed, engine, landPull, note } = library([row('n1', { title: 'old' })]);
    const base = note('n1');
    // A tag made by this very save: the answer names it, the device holds no id for it.
    vi.mocked(api.updateNote).mockResolvedValue({ ...base, title: 'new', tags: ['brand new'], updatedAt: 101 });
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new', tags: ['brand new'] }, base });
    await tick();

    const replay = fake.replayOne();
    await vi.waitFor(() => expect(engine.pull).toHaveBeenCalled());
    // The server has answered, the pull is in flight: the entry is still open, so the
    // optimistic row stands and nothing shows the copy from before the save.
    expect(fake.queue).toHaveLength(1);
    expect(lib.notes.get('n1')?.title).toBe('new');

    delivered(lib, feed, row('n1', { title: 'new', tagIds: ['t-new'], updatedAt: 101 }));
    landPull();
    expect(await replay).toBe('done');
    await tick();
    expect(lib.notes.get('n1')).toMatchObject({ title: 'new', updatedAt: 101, tagIds: ['t-new'] });
  });

  it('during the first copy, the row shows the server’s copy as soon as the entry ends', async () => {
    const { lib, fake, engine, note } = library([row('n1', { title: 'old' })]);
    engine.state.phase = 'hydrating';
    const base = note('n1');
    vi.mocked(api.updateNote).mockResolvedValue({ ...base, title: 'new', updatedAt: 101 });
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base });
    await tick();
    expect(await fake.replayOne()).toBe('done');
    await tick();
    expect(lib.notes.get('n1')).toMatchObject({ title: 'new', updatedAt: 101 });
  });

  it('does not wait for the first copy to finish before its entry ends', async () => {
    const { fake, engine } = library([row('n1')]);
    engine.state.phase = 'hydrating';
    vi.mocked(api.deleteNote).mockResolvedValueOnce(undefined);
    await actions.trashNote('n1');
    await tick();
    // The pull is in flight for the whole walk and never released here.
    expect(await fake.replayOne()).toBe('done');
    expect(engine.pull).toHaveBeenCalled();
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
    // The refusal keeps what the save carried: the typing, and the copy it was made from.
    expect(lib.outbox.status().conflicts.get('n1')).toMatchObject({ current: { updatedAt: 200 }, draft: { title: 'mine' }, base: { updatedAt: 100 } });
    expect(await fake.replayOne()).toBe('empty');
  });

  it('keeps a conflict across a reload until the choice is made', async () => {
    const { lib, fake, landPull, note } = library([row('n1', { title: 'old', body: 'ours' })]);
    const base = note('n1');
    const theirs: Note = { ...base, body: 'theirs', updatedAt: 200 };
    vi.mocked(api.updateNote).mockRejectedValueOnce(new NoteChangedError(theirs));
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'mine' }, base });
    await tick();
    const replay = fake.replayOne();
    await tick();
    landPull();
    expect(await replay).toBe('refused');
    await tick();

    // The tab closed and opened again: a new outbox on the same database.
    const reopened = createOutbox('u1', lib);
    await reopened.ready;
    expect(reopened.status().conflicts.get('n1')).toMatchObject({ current: { updatedAt: 200 }, draft: { title: 'mine' }, base: { updatedAt: 100 } });

    reopened.resolveConflict('n1');
    await tick();
    const again = createOutbox('u1', lib);
    await again.ready;
    expect(again.status().conflicts.size).toBe(0);
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

describe('saves of one note', () => {
  it('keep one entry in the outbox, the latest draft on the oldest base, and the retired one does nothing', async () => {
    const { lib, fake, landPull, note } = library([row('n1', { title: 'old' })]);
    await lib.outbox.ready;
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'a' }, base });
    await tick();
    // The second autosave comes with a base the workspace moved on — it does not, in the
    // library path, but a later copy must never become the precondition.
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'ab' }, base: { ...base, updatedAt: 100 } });
    await tick();
    expect(lib.outbox.status().pending).toBe(1);
    expect(await fake.config.storage.keys()).toHaveLength(1);
    expect(lib.notes.get('n1')?.title).toBe('ab');

    // The scheduler still holds both; the first ends without a request.
    expect(fake.queue).toHaveLength(2);
    const first = fake.replayOne();
    await tick();
    landPull();
    expect(await first).toBe('done');
    expect(api.updateNote).not.toHaveBeenCalled();

    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, title: 'ab', updatedAt: 101 });
    const second = fake.replayOne();
    await tick();
    landPull();
    expect(await second).toBe('done');
    expect(vi.mocked(api.updateNote).mock.calls).toEqual([['n1', { title: 'ab', ifUpdatedAt: 100 }]]);
    expect(lib.outbox.status().pending).toBe(0);
  });

  it('typed back to what the server holds, retires the waiting save and sends nothing', async () => {
    const { lib, fake, landPull, note } = library([row('n1', { title: 'old' })]);
    await lib.outbox.ready;
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'oldx' }, base });
    await tick();
    expect(lib.notes.get('n1')?.title).toBe('oldx');
    // The x deleted again: the draft is the base, and the save of the x must not go.
    expect(await actions.saveNote({ noteId: 'n1', value: seedFrom(base), base })).toBe('unchanged');
    await tick();
    expect(lib.notes.get('n1')?.title).toBe('old');
    expect(await fake.config.storage.keys()).toHaveLength(0);
    expect(lib.outbox.status().pending).toBe(0);
    // The retired entry, still in the scheduler, ends without a request.
    const replay = fake.replayOne();
    await tick();
    landPull();
    expect(await replay).toBe('done');
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('retiring a save leaves a later write of the same note standing', async () => {
    const { lib, note } = library([row('n1', { title: 'old' })]);
    await lib.outbox.ready;
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'a' }, base });
    await actions.trashNote('n1');
    await tick();
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'ab' }, base });
    await tick();
    expect(lib.notes.get('n1')).toMatchObject({ title: 'ab' });
    expect(lib.notes.get('n1')?.deletedAt).toBeDefined();
  });

  it('carries a "Keep mine" precondition forward onto the autosave that follows it', async () => {
    const { lib, fake, landPull, note } = library([row('n1', { title: 'old' })]);
    await lib.outbox.ready;
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'mine' }, base, against: 200 });
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'mine, and more' }, base });
    await tick();
    await fake.replayOne();
    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, title: 'mine, and more', updatedAt: 201 });
    const replay = fake.replayOne();
    await tick();
    landPull();
    await replay;
    expect(vi.mocked(api.updateNote).mock.calls).toEqual([['n1', { title: 'mine, and more', ifUpdatedAt: 200 }]]);
  });

  it('retires a save a reload restored when a new save of its note is queued', async () => {
    // An entry from before the reload: in storage and in the executor's queue before the
    // outbox learns what was restored.
    const { lib, note } = library([row('n1', { title: 'old' })]);
    const base = note('n1');
    const restored = { id: 'restored', mutationFnName: 'saveNote', metadata: { noteId: 'n1', value: { ...seedFrom(base), title: 'before' }, base }, createdAt: new Date(0) };
    const fresh = createOutbox('u1', lib);
    const fake2 = fakes[fakes.length - 1]!;
    fake2.queue.push(restored);
    await fake2.config.storage.set('tx:restored', JSON.stringify(restored));
    await fresh.ready;
    provideLibrary(async () => ({ ...lib, outbox: fresh }));

    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'after' }, base });
    await tick();
    expect(await fake2.config.storage.keys()).not.toContain('tx:restored');
    expect(await fake2.replayOne()).toBe('done');
    expect(api.updateNote).not.toHaveBeenCalled();
  });
});

describe('what waits for the server', () => {
  it('names the notes with an entry waiting, until each entry ends', async () => {
    const { lib, fake, landPull, note } = library([row('n1', { title: 'old' }), row('n2')]);
    await lib.outbox.ready;
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base });
    await actions.trashNotes(['n2']);
    await tick();
    expect([...lib.outbox.status().waiting].sort()).toEqual(['n1', 'n2']);
    // A replay the server could not take keeps the entry, and the note keeps waiting.
    vi.mocked(api.updateNote).mockRejectedValueOnce(new OfflineError());
    expect(await fake.replayOne()).toBe('kept');
    expect([...lib.outbox.status().waiting].sort()).toEqual(['n1', 'n2']);
    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, title: 'new', updatedAt: 101 });
    expect(await fake.replayOne()).toBe('done');
    expect([...lib.outbox.status().waiting]).toEqual(['n2']);
    vi.mocked(api.deleteNotes).mockResolvedValueOnce({ trashed: 1 });
    const replay = fake.replayOne();
    await tick();
    landPull();
    await replay;
    expect(lib.outbox.status().waiting.size).toBe(0);
  });


  it('counts a write the moment it is stored, so a write made offline is "syncing" at once', async () => {
    const { lib, fake } = library([row('n1')]);
    const seen: number[] = [];
    lib.outbox.subscribe((s) => seen.push(s.pending));
    expect(lib.outbox.status()).toMatchObject({ pending: 0, durable: true });
    await actions.trashNote('n1');
    await tick();
    expect(lib.outbox.status().pending).toBe(1);
    expect(seen).toContain(1);
    expect(fake.queue).toHaveLength(1);
  });

  it('says when a write queued here would not outlive the tab', async () => {
    const { lib, fake } = library([]);
    const seen: boolean[] = [];
    lib.outbox.subscribe((s) => seen.push(s.durable));
    fake.lead(false);
    expect(lib.outbox.status().durable).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});

describe('a copy put back from a note’s history', () => {
  it('is a request, and its answer is in the local copy when it returns', async () => {
    const { lib, fake, note } = library([row('n1', { title: 'gutted', body: '' })]);
    await lib.outbox.ready;
    const restored = { ...note('n1'), title: 'whole', body: 'the long text', updatedAt: 200 };
    vi.mocked(api.restoreRevision).mockResolvedValueOnce(restored);
    const heard = vi.fn();
    const off = actions.onDirectWrite(heard);

    expect(await actions.restoreRevision('n1', 7)).toEqual(restored);
    off();
    expect(api.restoreRevision).toHaveBeenCalledWith('n1', 7, {});
    // Nothing queued: history is the server's, and so is keeping what the restore replaced.
    expect(fake.queue).toHaveLength(0);
    expect(lib.notes.get('n1')).toMatchObject({ title: 'whole', body: 'the long text', updatedAt: 200 });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('waits for the note’s own save to reach the server first', async () => {
    const { lib, fake, note } = library([row('n1', { title: 'old' })]);
    await lib.outbox.ready;
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'typed' }, base });
    await tick();
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ ...base, title: 'restored', updatedAt: 300 });

    const restoring = actions.restoreRevision('n1', 7);
    await tick();
    // The save is still in the outbox, so the server has not been asked.
    expect(api.restoreRevision).not.toHaveBeenCalled();

    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, title: 'typed', updatedAt: 200 });
    expect(await fake.replayOne()).toBe('done');
    expect(await restoring).toMatchObject({ title: 'restored' });
    expect(vi.mocked(api.updateNote).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.restoreRevision).mock.invocationCallOrder[0]!,
    );
  });

  it('refuses, and asks the server nothing, when the note’s save will not go', async () => {
    vi.useFakeTimers();
    try {
      const { lib, note } = library([row('n1', { title: 'old' })]);
      await lib.outbox.ready;
      const base = note('n1');
      await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'typed' }, base });
      await vi.advanceTimersByTimeAsync(0);

      const restoring = actions.restoreRevision('n1', 7);
      const refused = expect(restoring).rejects.toThrow(/not synced yet/);
      await vi.advanceTimersByTimeAsync(5000);
      await refused;
      expect(api.restoreRevision).not.toHaveBeenCalled();
      // The typing is where it was: on the row, and waiting.
      expect(lib.notes.get('n1')!.title).toBe('typed');
      expect(lib.outbox.status().waiting.has('n1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a history only once the note’s own save has landed, so the save cannot refill it', async () => {
    const { lib, fake, note } = library([row('n1', { body: 'the code is 12345' })]);
    await lib.outbox.ready;
    const base = note('n1');
    // The save that takes the code out: the write whose landing keeps a copy with it in.
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), body: 'the code is in the safe' }, base });
    await tick();
    vi.mocked(api.clearRevisions).mockResolvedValueOnce(1);

    const clearing = actions.clearHistory('n1');
    await tick();
    expect(api.clearRevisions).not.toHaveBeenCalled();
    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, body: 'the code is in the safe', updatedAt: 200 });
    expect(await fake.replayOne()).toBe('done');
    expect(await clearing).toBe(1);
    expect(vi.mocked(api.updateNote).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.clearRevisions).mock.invocationCallOrder[0]!,
    );
  });

  it('with no library, is the request and nothing else', async () => {
    const restored = { id: 'n1', title: 'whole', body: 'text', tags: [], createdAt: 1, updatedAt: 2 } as Note;
    vi.mocked(api.restoreRevision).mockResolvedValueOnce(restored);
    expect(await actions.restoreRevision('n1', 7)).toEqual(restored);
  });
});

describe('a tab that does not hold the outbox', () => {
  it('makes the write as a request, and offline fails it rather than pretending it was saved', async () => {
    const { lib, fake, engine, note } = library([row('n1', { title: 'old' })]);
    fake.lead(false);
    const base = note('n1');
    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, title: 'new', updatedAt: 101 });
    const out = await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base });
    expect(out).toMatchObject({ title: 'new', updatedAt: 101 });
    expect(fake.queue).toHaveLength(0);
    // The library is brought current with the answer rather than left to the next nudge.
    expect(engine.pull).toHaveBeenCalled();

    vi.mocked(api.updateNote).mockRejectedValueOnce(new OfflineError());
    await expect(actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'newer' }, base })).rejects.toBeInstanceOf(OfflineError);
    expect(lib.notes.get('n1')?.title).toBe('old');
    expect(lib.outbox.status()).toMatchObject({ pending: 0, durable: false });
  });
});

describe('the no-library path', () => {
  it('tells the queries about a write, since nothing else would', async () => {
    provideLibrary(async () => null);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const stop = installLibraryQueries(client);
    vi.mocked(api.deleteNote).mockResolvedValueOnce(undefined);
    await actions.trashNote('n1');
    expect(invalidate).toHaveBeenCalledTimes(1);
    const { predicate } = invalidate.mock.calls[0]![0] as { predicate: (q: { queryKey: readonly unknown[] }) => boolean };
    expect(predicate({ queryKey: keys.notes({}) })).toBe(true);
    expect(predicate({ queryKey: keys.trash() })).toBe(true);
    expect(predicate({ queryKey: keys.notebooks() })).toBe(true);
    expect(predicate({ queryKey: keys.search('x') })).toBe(false);
    stop();
  });

  it('does the request and answers with the server’s copy', async () => {
    provideLibrary(async () => null);
    const base: Note = { id: 'n1', title: 'old', body: '', tags: [], notebook: null, createdAt: 1, updatedAt: 100, fields: [] };
    vi.mocked(api.updateNote).mockResolvedValue({ ...base, title: 'new', updatedAt: 101 });
    const out = await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base });
    expect(out).toMatchObject({ title: 'new' });
    expect(api.updateNote).toHaveBeenCalledWith('n1', { title: 'new', ifUpdatedAt: 100 });
  });
});

describe('a note the copy does not hold yet', () => {
  const missing: Note = { id: 'n-missing', title: 'old', body: '', tags: [], notebook: null, createdAt: 1, updatedAt: 100, fields: [] };

  /** A library whose first copy is still walking: no snapshot has been taken. */
  function copying(notes: LocalNote[]) {
    const out = library(notes);
    out.engine.state.cursor = null;
    return out;
  }

  it('saves it as a request rather than throwing on the missing row', async () => {
    // A link followed during the first copy: the editor has the server's note, the
    // collection does not. `update` used to throw UpdateKeyNotFoundError and the
    // typing was gone on the next open.
    const { fake, engine } = copying([]);
    vi.mocked(api.updateNote).mockResolvedValue({ ...missing, title: 'new', updatedAt: 101 });
    const out = await actions.saveNote({
      noteId: missing.id,
      value: { ...seedFrom(missing), title: 'new' },
      base: missing,
    });
    expect(out).toMatchObject({ title: 'new', updatedAt: 101 });
    expect(api.updateNote).toHaveBeenCalledWith(missing.id, { title: 'new', ifUpdatedAt: 100 });
    expect(fake.queue).toHaveLength(0);
    expect(engine.pull).toHaveBeenCalled();
  });

  it('trashes, restores and purges it as a request', async () => {
    const { fake, engine } = copying([]);
    vi.mocked(api.deleteNote).mockResolvedValueOnce(undefined);
    await actions.trashNote(missing.id);
    expect(api.deleteNote).toHaveBeenCalledWith(missing.id);
    expect(fake.queue).toHaveLength(0);
    expect(engine.pull).toHaveBeenCalled();

    vi.mocked(api.restoreNote).mockResolvedValueOnce(missing);
    await actions.restoreNote(missing.id);
    expect(api.restoreNote).toHaveBeenCalledWith(missing.id);

    vi.mocked(api.deleteNotePermanently).mockResolvedValueOnce(undefined);
    await actions.purgeNote(missing.id);
    expect(api.deleteNotePermanently).toHaveBeenCalledWith(missing.id);
  });

  it('queues the notes held here and sends only the rest of a bulk action', async () => {
    // Search still hits the server, so a result can be a note the walk has not reached.
    // The held one stays in the outbox, behind whatever of its own is already waiting
    // there; only the one the copy lacks goes as a request.
    const { fake, engine, lib } = copying([row('n1')]);
    vi.mocked(api.deleteNotes).mockResolvedValueOnce({ trashed: 1 });
    expect(await actions.trashNotes(['n1', missing.id])).toBe(2);
    await tick();
    expect(api.deleteNotes).toHaveBeenCalledWith([missing.id]);
    expect(fake.queue.map((e) => e.metadata)).toEqual([{ ids: ['n1'] }]);
    expect(lib.notes.get('n1')?.deletedAt).toBeDefined();
    expect(engine.pull).toHaveBeenCalled();
  });

  it('moves and tags a mixed selection the same way', async () => {
    const { fake } = copying([row('n1')]);
    vi.mocked(api.updateNotes).mockResolvedValue({ updated: 1 } as never);
    await actions.moveNotes(['n1', missing.id], 'Coupons');
    await actions.tagNotes(['n1', missing.id], { add: ['saved'] });
    await tick();
    expect(api.updateNotes).toHaveBeenNthCalledWith(1, [missing.id], { notebook: 'Coupons' });
    expect(api.updateNotes).toHaveBeenNthCalledWith(2, [missing.id], { addTags: ['saved'], removeTags: undefined });
    expect(fake.queue.map((e) => e.metadata)).toEqual([{ ids: ['n1'], notebook: 'Coupons' }, { ids: ['n1'], add: ['saved'] }]);
  });

  it('queues nothing when the request for the rest of a bulk action fails', async () => {
    // Half an action applied while the list says it failed would skip telling the open
    // note's draft, whose next save put the old filing back. The request goes first.
    const { fake, lib } = copying([row('n1')]);
    vi.mocked(api.updateNotes).mockRejectedValueOnce(new OfflineError());
    await expect(actions.moveNotes(['n1', missing.id], 'Coupons')).rejects.toBeInstanceOf(OfflineError);
    await tick();
    expect(fake.queue).toHaveLength(0);
    expect(lib.notes.get('n1')?.notebookName).toBeUndefined();
  });

  it('leaves out of a bulk action a note gone once a snapshot has been taken', async () => {
    // A selection outlives a purge the feed delivered. With the copy whole, the id is
    // not a note: the rest is queued and nothing goes to the server, offline or not.
    const { fake } = library([row('n1')]);
    setReachableForTests(false);
    expect(await actions.trashNotes(['n1', missing.id])).toBe(1);
    await tick();
    expect(api.deleteNotes).not.toHaveBeenCalled();
    expect(fake.queue.map((e) => e.metadata)).toEqual([{ ids: ['n1'] }]);
  });

  it('refuses a single write to a note gone once a snapshot has been taken', async () => {
    library([]);
    await expect(actions.trashNote(missing.id)).rejects.toMatchObject({ status: 404 });
    expect(api.deleteNote).not.toHaveBeenCalled();
  });
});

describe('a file added to a note', () => {
  let root: MemoryDirectory;
  const photo = (name = 'photo.jpg', text = 'jpeg bytes') => new File([text], name, { type: 'image/jpeg' });
  const answer = (filename: string) => ({ filename, contentType: 'image/jpeg', size: 10, path: `files/${filename}`, indexing: 'server' as const });
  const files = (lib: WritableLibrary) => [...lib.attachments.values()].map((a) => ({ ...a }));
  beforeEach(() => {
    root = installMemoryOpfs();
  });

  it('is an ordinary request with a connection and nothing of the note’s waiting', async () => {
    const { lib, fake } = library([row('n1')]);
    vi.mocked(api.uploadFile).mockResolvedValueOnce(answer('photo.jpg'));
    const file = photo();
    expect(await actions.uploadFile('n1', file)).toEqual(answer('photo.jpg'));
    expect(api.uploadFile).toHaveBeenCalledWith('n1', file, { id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(fake.queue).toHaveLength(0);
    expect(root.paths()).toEqual([]);
    expect(files(lib)).toEqual([]);
    // Nothing is being kept on the device, so the browser is not asked to keep anything:
    // one that prompts would prompt here about nothing the person did.
    expect(navigator.storage.persist).not.toHaveBeenCalled();
  });

  it('with no connection, is kept on the device, listed as waiting, and queued; then uploaded under the id its row has', async () => {
    const { lib, fake, engine, landPull } = library([row('n1')]);
    setReachableForTests(false);
    const uploaded = vi.fn();
    const stop = actions.onUploaded(uploaded);

    const out = await actions.uploadFile('n1', photo());
    expect(out).toEqual({ filename: 'photo.jpg', contentType: 'image/jpeg', size: 10, path: 'files/photo.jpg', indexing: 'server' });
    expect(api.uploadFile).not.toHaveBeenCalled();
    await tick();
    expect(root.paths()).toEqual(['unbent-files-u1/pending/n1/photo.jpg']);
    // The only copy of the file is now on this device: the browser is asked not to clear it.
    expect(navigator.storage.persist).toHaveBeenCalled();
    const [waiting] = files(lib);
    expect(waiting).toMatchObject({ noteId: 'n1', filename: 'photo.jpg', size: 10, pending: true });
    expect(fake.queue.map((e) => e.mutationFnName)).toEqual(['uploadFile']);
    // The note is one the server has not heard all of: the head marks it.
    expect(lib.outbox.status().waiting.has('n1')).toBe(true);

    setReachableForTests(true);
    vi.mocked(api.uploadFile).mockResolvedValueOnce(answer('photo.jpg'));
    const replay = fake.replayOne();
    await vi.waitFor(() => expect(engine.pull).toHaveBeenCalled());
    landPull();
    expect(await replay).toBe('done');
    const [, sent, opts] = vi.mocked(api.uploadFile).mock.calls[0]!;
    expect(opts).toEqual({ id: waiting!.id });
    expect((sent as File).name).toBe('photo.jpg');
    expect(await (sent as File).text()).toBe('jpeg bytes');
    expect(uploaded).toHaveBeenCalledWith('n1', answer('photo.jpg'), expect.any(File));
    stop();
    // Off the shelf once the server has it, and the note no longer waits.
    expect(root.paths()).toEqual([]);
    expect(lib.outbox.status().waiting.has('n1')).toBe(false);
    expect(lib.outbox.status().uploadNotices.size).toBe(0);
  });

  it('is queued under the id the request carried when the connection went mid-upload, so the replay finds what the server may have stored', async () => {
    const { lib, fake, engine, landPull } = library([row('n1')]);
    // The bytes may have arrived; the answer did not.
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new OfflineError());
    await actions.uploadFile('n1', photo());
    await tick();
    const first = vi.mocked(api.uploadFile).mock.calls[0]![2] as { id: string };
    expect([...lib.attachments.values()][0]).toMatchObject({ id: first.id, pending: true });

    vi.mocked(api.uploadFile).mockResolvedValueOnce(answer('photo.jpg'));
    const replay = fake.replayOne();
    await vi.waitFor(() => expect(engine.pull).toHaveBeenCalled());
    landPull();
    expect(await replay).toBe('done');
    expect(vi.mocked(api.uploadFile).mock.calls[1]![2]).toEqual({ id: first.id });
  });

  it('goes into the cache of opened files once it has uploaded, unless it is over that cache’s cap', async () => {
    const put = vi.fn(async () => {});
    vi.stubGlobal('caches', { open: async () => ({ put }) });
    // jsdom's File is not one the test runtime's Response takes; what is put is not the point here.
    vi.stubGlobal('Response', class {});
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, storage: navigator.storage, serviceWorker: { controller: { postMessage } } });
    const { fake, engine, landPull } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo('small.jpg', 'ten bytes!'));
    await actions.uploadFile('n1', photo('big.jpg', 'more than the twelve bytes this file’s cap is set to'));
    await tick();
    vi.mocked(api.uploadFile).mockImplementation(async (_n, f) => answer(f.name));
    setReachableForTests(true);
    for (let i = 0; i < 2; i += 1) {
      const replay = fake.replayOne();
      await vi.waitFor(() => expect(engine.pull).toHaveBeenCalled());
      landPull();
      expect(await replay).toBe('done');
      engine.pull.mockClear();
    }
    expect(put.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['/api/notes/n1/files/small.jpg']);
    // And the worker is told, once, for the one that went in: its index is what Settings counts.
    expect(postMessage.mock.calls).toEqual([[{ type: 'FILES_CHANGED' }]]);
  });

  it('goes behind the note’s own entry when the note has one waiting, even with a connection', async () => {
    const { fake } = library([]);
    const made = await actions.createNote({ title: 'Made offline', body: '', tags: [], notebook: null });
    await tick();
    await actions.uploadFile(made.id, photo());
    await tick();
    expect(api.uploadFile).not.toHaveBeenCalled();
    expect(fake.queue.map((e) => e.mutationFnName)).toEqual(['createNote', 'uploadFile']);
  });

  it('takes the name the server would give it when the note already has one by that name', async () => {
    const { lib } = library([row('n1')]);
    setReachableForTests(false);
    expect((await actions.uploadFile('n1', photo())).path).toBe('files/photo.jpg');
    expect((await actions.uploadFile('n1', photo())).path).toBe('files/photo-2.jpg');
    await tick();
    expect(files(lib).map((f) => f.filename).sort()).toEqual(['photo-2.jpg', 'photo.jpg']);
    expect(root.paths()).toEqual(['unbent-files-u1/pending/n1/photo-2.jpg', 'unbent-files-u1/pending/n1/photo.jpg']);
  });

  it('refuses up front what the server would refuse later: a file over the cap, a name it does not take', async () => {
    const { fake } = library([row('n1')]);
    setReachableForTests(false);
    const huge = photo();
    Object.defineProperty(huge, 'size', { value: 96 * 1024 * 1024 });
    await expect(actions.uploadFile('n1', huge)).rejects.toThrow('Attachment exceeds 95MB limit');
    await expect(actions.uploadFile('n1', photo('.hidden'))).rejects.toThrow('may not start with a dot');
    expect(fake.queue).toHaveLength(0);
    expect(root.paths()).toEqual([]);
  });

  it('refuses a file the device has no room to hold', async () => {
    library([row('n1')]);
    setReachableForTests(false);
    vi.stubGlobal('navigator', { ...navigator, storage: { ...navigator.storage, estimate: async () => ({ usage: 995, quota: 1000 }) } });
    await expect(actions.uploadFile('n1', photo())).rejects.toThrow('Not enough room on this device');
  });

  it('keeps the file through a lost connection and a server that is down, and through a refused session', async () => {
    const { fake } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo());
    await tick();
    for (const err of [new OfflineError(), new ApiError(503, 'Unavailable'), new ApiError(401, 'Unauthorized')]) {
      vi.mocked(api.uploadFile).mockRejectedValueOnce(err);
      expect(await fake.replayOne()).toBe('kept');
      expect(root.paths()).toEqual(['unbent-files-u1/pending/n1/photo.jpg']);
    }
    expect(fake.queue).toHaveLength(1);
  });

  it('says so when the server refuses the upload for good, and lets the next entry through', async () => {
    const { lib, fake } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo());
    await actions.trashNote('n1');
    await tick();
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new ApiError(413, 'Attachment exceeds 95MB limit'));
    expect(await fake.replayOne()).toBe('refused');
    await tick();
    expect(root.paths()).toEqual([]);
    expect(files(lib)).toEqual([]);
    expect(lib.outbox.status().uploadNotices.get('n1')).toEqual([expect.objectContaining({ filename: 'photo.jpg', message: 'Couldn’t upload. Attachment exceeds 95MB limit' })]);
    expect(fake.queue.map((e) => e.mutationFnName)).toEqual(['trashNote']);
    lib.outbox.dismissUploadNotices('n1');
    expect(lib.outbox.status().uploadNotices.size).toBe(0);
  });

  it('says so when the server stored it under another name', async () => {
    const { lib, fake, engine, landPull } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo());
    await tick();
    vi.mocked(api.uploadFile).mockResolvedValueOnce(answer('photo-2.jpg'));
    const replay = fake.replayOne();
    await vi.waitFor(() => expect(engine.pull).toHaveBeenCalled());
    landPull();
    expect(await replay).toBe('done');
    expect(lib.outbox.status().uploadNotices.get('n1')?.[0]?.message).toContain('Stored as “photo-2.jpg”');
  });

  it('can be taken back before it uploads: no request, no row, no bytes, and the note no longer waits', async () => {
    const { lib, fake } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo('wrong photo.jpg'));
    await tick();
    expect(await actions.cancelUpload('n1', 'wrong photo.jpg')).toBe(true);
    await tick();
    expect(files(lib)).toEqual([]);
    expect(root.paths()).toEqual([]);
    expect(lib.outbox.status()).toMatchObject({ pending: 0 });
    expect(lib.outbox.status().waiting.has('n1')).toBe(false);

    // Its turn comes and nothing is sent.
    setReachableForTests(true);
    expect(await fake.replayOne()).toBe('done');
    expect(api.uploadFile).not.toHaveBeenCalled();
    expect(lib.outbox.status().uploadNotices.size).toBe(0);
    // A file that is not waiting is not this function's to remove.
    expect(await actions.cancelUpload('n1', 'wrong photo.jpg')).toBe(false);
  });

  it('deletes a waiting file locally and an uploaded one on the server', async () => {
    library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo('wrong photo.jpg'));
    await tick();
    await actions.deleteOrCancelAttachment('n1', 'wrong photo.jpg');
    expect(api.deleteAttachment).not.toHaveBeenCalled();

    vi.mocked(api.deleteAttachment).mockResolvedValueOnce(undefined);
    await actions.deleteOrCancelAttachment('n1', 'uploaded.jpg');
    expect(api.deleteAttachment).toHaveBeenCalledWith('n1', 'uploaded.jpg');
  });

  it('cannot be taken back while it is being sent', async () => {
    const { fake } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo());
    await tick();
    setReachableForTests(true);
    let land: (v: ReturnType<typeof answer>) => void = () => {};
    vi.mocked(api.uploadFile).mockReturnValueOnce(new Promise((r) => (land = r)));
    const replay = fake.replayOne();
    await vi.waitFor(() => expect(api.uploadFile).toHaveBeenCalled());
    await expect(actions.cancelUpload('n1', 'photo.jpg')).rejects.toThrow('uploading right now');
    land(answer('photo.jpg'));
    void replay;
  });

  it('is a request, failing as one, in a tab that does not hold the outbox', async () => {
    const { fake } = library([row('n1')]);
    fake.lead(false);
    setReachableForTests(false);
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new OfflineError());
    await expect(actions.uploadFile('n1', photo())).rejects.toBeInstanceOf(OfflineError);
    expect(root.paths()).toEqual([]);
  });
});
