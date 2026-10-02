import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollection, type Collection } from '@tanstack/db';
import { QueryClient } from '@tanstack/react-query';
import type { FeedNote, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, NoteChangedError, OfflineError } from '../notes-api.js';
import { resetConnectivity } from '../connectivity.js';
import { seedFrom } from '../note-patch.js';
import { installLibraryQueries, keys } from '../queries.js';
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
    state: { phase: 'current' },
    pull: vi.fn(() => new Promise<void>((r) => (release = r))),
  } as unknown as FeedEngine & { pull: ReturnType<typeof vi.fn>; state: { phase: string } };
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
