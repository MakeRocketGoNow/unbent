import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollection, type Collection } from '@tanstack/db';
import { QueryClient } from '@tanstack/react-query';
import type { FeedEntity, FeedNote, FeedNotebook, FeedPage, FieldDef, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, NoteChangedError, OfflineError } from '../notes-api.js';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { seedFrom } from '../note-patch.js';
import { installLibraryQueries, keys } from '../queries.js';
import * as actions from './actions.js';
import { createOutbox, provideForwarder, provideLibrary, TAB_ORIGIN, type WritableLibrary } from './actions.js';
import { CallUnsettledError, LibraryMovedError } from './client-library.js';
import { lookups, toNote } from './derive.js';
import { feedControls, type Collections, type LocalNote } from './collections.js';
import { FeedEngine, type Position } from './feed.js';
import { installMemoryOpfs, type MemoryDirectory } from './test-opfs.js';
import { planLapsed, resetPlanRefused } from '../plan-refused.js';

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
  // The executor's own policy, which the fake asks as the executor does: it has views of
  // its own about what ends an entry, and a fake that skipped it once hid one.
  const { DefaultRetryPolicy } = await vi.importActual<typeof import('@tanstack/offline-transactions')>('@tanstack/offline-transactions');
  const policy = new DefaultRetryPolicy(Number.POSITIVE_INFINITY, false);

  /** IndexedDB as the executor uses it: a database per name that outlives the adapter object. */
  const databases = new Map<string, Map<string, string>>();
  class MemoryAdapter {
    static databases = databases;
    /** Every adapter made, newest last, for a test that needs the connection itself. */
    static instances: MemoryAdapter[] = [];
    /**
     * The connection the real adapter keeps under `db`: closable, told of a delete, and
     * opened on first use as the real one is — null until then, which is what a tab that
     * does not lead the outbox has when its executor's init settles.
     */
    db: { close: () => void; onversionchange: null | (() => void); closed: boolean } | null = null;
    rows: Map<string, string>;
    constructor(readonly name: string) {
      this.rows = databases.get(name) ?? new Map();
      databases.set(name, this.rows);
      MemoryAdapter.instances.push(this);
    }
    private open() {
      if (this.db) return;
      const db = { closed: false, onversionchange: null, close: () => void (db.closed = true) };
      this.db = db;
    }
    async get(key: string) {
      this.open();
      return this.rows.get(key) ?? null;
    }
    async set(key: string, value: string) {
      this.open();
      this.rows.set(key, value);
    }
    async delete(key: string) {
      this.open();
      this.rows.delete(key);
    }
    async keys() {
      this.open();
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
        if (!policy.shouldRetry(err as Error, 0)) {
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
  importNotebook: vi.fn(),
  purgeNotes: vi.fn(),
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

const amount: FieldDef = {
  id: '11111111-1111-1111-1111-111111111111',
  notebookId: 'nb1',
  name: 'Amount',
  type: 'number',
  options: [],
  scale: null,
  currency: null,
  position: 0,
};

const receipts: FeedNotebook = { id: 'nb1', name: 'Receipts', purpose: null, emoji: null, fieldDefs: [amount] };

/** The server's copy as the feed would deliver it. */
const delivered = (lib: WritableLibrary, feed: Controls<LocalNote>, note: LocalNote) => {
  feed.begin();
  feed.write({ type: lib.notes.has(note.id) ? 'update' : 'insert', value: note });
  feed.commit();
};

function library(notes: LocalNote[], notebooks: FeedNotebook[] = []) {
  const n = collection(notes, (r) => r.id);
  const nb = collection(notebooks, (r) => r.id);
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

/**
 * A library fed by the real engine, through the controls `collections.ts` gives it, from a
 * server this file answers for. `library()`'s stand-in engine cannot show what a pull
 * inside a replay does to the rows under TanStack DB's own rules for sync that arrives
 * while a write is in flight, and a replay once stalled on exactly those rules.
 */
async function fedLibrary(notes: LocalNote[]) {
  /** What the server has written, in order: a note as it now stands, or a purge. */
  const log: { seq: number; note?: FeedNote; purged?: string }[] = [];
  let position: Position | null = { seq: 1, epoch: 'test' };
  const page = (path: string): FeedPage => {
    const since = Number(new URL(path, 'http://x').searchParams.get('since'));
    const after = log.filter((e) => e.seq > since);
    return {
      reset: false,
      seq: log.at(-1)?.seq ?? 1,
      epoch: 'test',
      next: after.at(-1)?.seq ?? since,
      more: false,
      notes: after.flatMap((e) => (e.note ? [e.note] : [])),
      notebooks: [],
      tags: [],
      attachments: [],
      tombstones: after.flatMap((e) => (e.purged ? [{ entity: 'note' as const, id: e.purged }] : [])),
    };
  };
  const engine = new FeedEngine({
    fetchJson: async <T,>(path: string) => page(path) as T,
    readCursor: async () => position,
    writeCursor: async (p) => void (position = p),
  });
  const fed = <T extends object>(entity: FeedEntity, seed: T[], keyOf: (row: T) => string) =>
    createCollection<T, string>({
      id: `fed-${entity}-${Math.random().toString(36).slice(2)}`,
      getKey: keyOf,
      startSync: true,
      sync: {
        sync: (handles) => {
          // The rows a persisted collection restores before its sync starts.
          handles.begin();
          for (const r of seed) handles.write({ type: 'insert', value: r });
          handles.commit();
          return engine.register(entity, feedControls<T>(handles) as never);
        },
      },
    });
  const collections = {
    notes: fed<LocalNote>('note', notes, (r) => r.id),
    notebooks: fed<{ id: string }>('notebook', [], (r) => r.id),
    tags: fed<{ id: string }>('tag', [], (r) => r.id),
    attachments: fed<{ id: string }>('attachment', [], (r) => r.id),
    syncState: collection<{ id: string }>([], (r) => r.id).c,
  } as unknown as Collections;
  const outbox = createOutbox('u1', { ...collections, userId: 'u1', engine });
  const lib: WritableLibrary = { ...collections, userId: 'u1', engine, outbox };
  provideLibrary(async () => lib);
  // The pull every library makes on open, settled, so the copy is whole before a test writes.
  await vi.waitFor(() => expect(engine.state.phase).toBe('current'));
  let seq = 1;
  return {
    lib,
    fake: fakes[fakes.length - 1]!,
    server: {
      /** The note as a write left it on the server. */
      wrote: (note: FeedNote) => void log.push({ seq: (seq += 1), note }),
      purged: (id: string) => void log.push({ seq: (seq += 1), purged: id }),
    },
    /** The row as the server last delivered it, under whatever writes are still pending here. */
    synced: (id: string) => (lib.notes as unknown as { _state: { syncedData: Map<string, LocalNote> } })._state.syncedData.get(id),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** What a replay came to, or `stuck` when it has not settled within a second. */
const settles = <T,>(p: Promise<T>) => Promise.race([p, new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 1000))]);

beforeEach(() => {
  resetPlanRefused();
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

  it('does not wait for a first copy that was cut short, either', async () => {
    // A walk stopped by a failed page is `failed`, not `hydrating`, and has no cursor:
    // the next pull resumes the whole walk, which the entry must not sit behind.
    const { fake, engine } = library([row('n1')]);
    engine.state.phase = 'failed';
    engine.state.cursor = null;
    vi.mocked(api.deleteNote).mockResolvedValueOnce(undefined);
    await actions.trashNote('n1');
    await tick();
    expect(await fake.replayOne()).toBe('done');
    expect(engine.pull).toHaveBeenCalled();
  });

  it('ends for good on a 4xx the server would give again, and is kept for one that may change', async () => {
    const { fake } = library([row('n1'), row('n2')]);
    await actions.trashNotes(['n1']);
    await actions.trashNotes(['n2']);
    await tick();
    expect(fake.queue).toHaveLength(2);

    // Worded as `httpErrorMessage` words them, status first: the library reads the words.
    for (const err of [
      new OfflineError(),
      new ApiError(401, '401: Unauthorized'),
      new ApiError(408, '408: Request Timeout'),
      new ApiError(429, '429: Too Many Requests'),
      new ApiError(503, '503: Service Unavailable: try again in 400 ms'),
    ]) {
      vi.mocked(api.deleteNotes).mockRejectedValueOnce(err);
      expect(await fake.replayOne()).toBe('kept');
    }
    expect(fake.queue).toHaveLength(2);

    // The plan's 402 is kept — it changes when the person subscribes — and the storage's
    // is not: the account is full until something goes (MAK-108). While the kept one
    // waits at the head of the queue, a delete goes to the server directly rather than
    // behind it, since the queue would hold it there until the subscription.
    vi.mocked(api.deleteNotes).mockRejectedValueOnce(new ApiError(402, '402: read-only', 'PLAN_INACTIVE'));
    expect(await fake.replayOne()).toBe('kept');
    expect(fake.queue).toHaveLength(2);
    expect(planLapsed()).toBe(true);
    vi.mocked(api.deleteNotes).mockResolvedValueOnce({ trashed: 1 });
    await actions.trashNotes(['n3']);
    expect(api.deleteNotes).toHaveBeenLastCalledWith(['n3']);
    expect(fake.queue).toHaveLength(2);
    vi.mocked(api.deleteNotes).mockRejectedValueOnce(new ApiError(402, '402: full', 'STORAGE_FULL'));
    expect(await fake.replayOne()).toBe('refused');
    expect(fake.queue).toHaveLength(1);

    vi.mocked(api.deleteNotes).mockRejectedValueOnce(new ApiError(403, '403: Forbidden'));
    expect(await fake.replayOne()).toBe('refused');
    expect(fake.queue).toHaveLength(0);
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

  it('takes the 404 of a trash or purge the server already made as done, through the real client, so the writes behind it go', async () => {
    // A replay of a request that already went — the tab closed before its entry ended —
    // finds the note trashed or purged already, and the route says 404. The client threw
    // that as a bare Error, which nothing read as a 404: the entry was kept and tried
    // again for good, the restores queued behind it never went, and a reload changed
    // nothing, since the outbox is kept across reloads.
    const { fake, engine } = library([row('n1'), row('n2', { deletedAt: 5 }), row('n3', { deletedAt: 5 })]);
    engine.pull.mockResolvedValue(undefined);
    const real = await vi.importActual<typeof import('../notes-api.js')>('../notes-api.js');
    // Once each, so the real client and its stubbed fetch do not outlive this test.
    vi.mocked(api.deleteNote).mockImplementationOnce(real.deleteNote);
    vi.mocked(api.deleteNotePermanently).mockImplementationOnce(real.deleteNotePermanently);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })));
    vi.mocked(api.restoreNote).mockResolvedValueOnce(toNote(row('n3'), lookups({ notes: [], notebooks: [], tags: [], attachments: [] })));
    await actions.trashNote('n1');
    await actions.purgeNote('n2');
    await actions.restoreNote('n3');
    await tick();

    expect(await fake.replayOne()).toBe('done');
    expect(await fake.replayOne()).toBe('done');
    expect(await fake.replayOne()).toBe('done');
    expect(api.restoreNote).toHaveBeenCalledWith('n3');
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

describe('a replay that pulls the feed', () => {
  it('ends while the writes queued after it still wait, rather than waiting on them', async () => {
    // Two notes trashed a moment apart: two entries, the second in flight until its turn.
    // The first replay's pull brings its own row back, and TanStack DB holds a page of
    // sync back while any write on the collection is in flight; the entry waited for the
    // page, the page for the entry, and only a reload ended it — sending the trash again.
    const { lib, fake, server, synced } = await fedLibrary([row('n1'), row('n2')]);
    const trash = async (ids: string[]) => {
      for (const id of ids) server.wrote(row(id, { deletedAt: 5 }));
      return { trashed: ids.length };
    };
    vi.mocked(api.deleteNotes).mockImplementationOnce(trash).mockImplementationOnce(trash);
    await actions.trashNotes(['n1']);
    await actions.trashNotes(['n2']);
    await tick();

    expect(await settles(fake.replayOne())).toBe('done');
    // The page is in the rows the feed wrote, not only waiting under the note still queued.
    expect(synced('n1')?.deletedAt).toBe(5);
    expect(await settles(fake.replayOne())).toBe('done');
    expect(api.deleteNotes).toHaveBeenCalledTimes(2);
    expect(lib.notes.get('n2')?.deletedAt).toBe(5);
    expect(lib.outbox.status().pending).toBe(0);
  });

  it('takes a purged note out of the rows, though the purge was hiding it when its tombstone came', async () => {
    // The purge's own pull brings the tombstone while the purge still hides the row. A
    // tombstone written only for a row the collection showed was dropped, the cursor went
    // past it, and the note came back when the purge ended: in the trash for good, on a
    // server that no longer had it, until a sign-out emptied the copy.
    const { lib, fake, server, synced } = await fedLibrary([row('n1', { deletedAt: 5 })]);
    vi.mocked(api.deleteNotePermanently).mockImplementationOnce(async (id) => server.purged(id));
    await actions.purgeNote('n1');
    await tick();
    expect(lib.notes.has('n1')).toBe(false);

    expect(await settles(fake.replayOne())).toBe('done');
    expect(synced('n1')).toBeUndefined();
    expect(lib.notes.has('n1')).toBe(false);
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

  it('from another tab, merge only when the draft holds the waiting change, and are otherwise refused as a conflict', async () => {
    const { lib, fake, note } = library([row('n1', { title: 'old', body: 'b' })]);
    await lib.outbox.ready;
    const base = note('n1');
    // Tab A renames the note; its save waits.
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'renamed' }, base, origin: 'A' });
    await tick();
    // Tab B, whose editor still shows the old title, types in the body: refused, with the
    // row as it stands, rather than retiring A's rename.
    const refused = actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), body: 'typed' }, base, origin: 'B' });
    await expect(refused).rejects.toBeInstanceOf(NoteChangedError);
    await expect(refused).rejects.toMatchObject({ current: { title: 'renamed' } });
    expect(lib.notes.get('n1')?.title).toBe('renamed');
    expect(fake.queue).toHaveLength(1);
    // B's editor took the rename up and types again: the two merge, as one editor's would.
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'renamed', body: 'typed' }, base, origin: 'B' });
    await tick();
    expect(lib.notes.get('n1')).toMatchObject({ title: 'renamed', body: 'typed' });
    expect(lib.outbox.status().pending).toBe(1);
    // This tab's own save carries the tab's origin, which is another editor's than B's.
    await expect(actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'mine' }, base })).rejects.toBeInstanceOf(NoteChangedError);
  });

  it('from another tab, Keep mine puts the draft over the waiting change rather than refusing it again', async () => {
    const { lib, note } = library([row('n1', { title: 'old', body: 'b' })]);
    await lib.outbox.ready;
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'renamed' }, base, origin: 'A' });
    await tick();
    const refused = actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), body: 'typed' }, base, origin: 'B' });
    await expect(refused).rejects.toBeInstanceOf(NoteChangedError);
    // Keep mine: the body is B's, the title B never touched is A's, and one save waits.
    const theirs = (await refused.catch((e: NoteChangedError) => e)) as NoteChangedError;
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), body: 'typed' }, base, against: theirs.current.updatedAt, origin: 'B' });
    await tick();
    expect(lib.notes.get('n1')).toMatchObject({ title: 'renamed', body: 'typed' });
    expect(lib.outbox.status().pending).toBe(1);
  });

  it('are the same editor’s whether this tab made them as a client or as the holder', async () => {
    const { lib, note } = library([row('n1', { title: 'old' })]);
    await lib.outbox.ready;
    const base = note('n1');
    // Made here as a client: the save went to a holder with this tab's origin, and is
    // restored by this tab once it holds the library.
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'renamed' }, base, origin: TAB_ORIGIN });
    await tick();
    // Typed back as the holder: the same editor's, so the waiting save is retired, not a conflict.
    await expect(actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'old' }, base })).resolves.toBe('unchanged');
    expect(lib.notes.get('n1')?.title).toBe('old');
    expect(lib.outbox.status().pending).toBe(0);
  });

  it('sends this tab’s origin with a save forwarded to the holder', async () => {
    library([row('n1')]);
    const sent: unknown[] = [];
    provideForwarder(async () => async (_name, args) => void sent.push(args[0]));
    const base: Note = { id: 'n1', title: 'old', body: '', tags: [], notebook: null, createdAt: 1, updatedAt: 100, fields: [] };
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'new' }, base });
    provideForwarder(async () => null);
    expect(sent[0]).toMatchObject({ origin: TAB_ORIGIN });
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
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: restored, kept: 9 });
    const heard = vi.fn();
    const off = actions.onDirectWrite(heard);

    expect(await actions.restoreRevision('n1', 7)).toEqual({ note: restored, kept: 9 });
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
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: { ...base, title: 'restored', updatedAt: 300 }, kept: 9 });

    const restoring = actions.restoreRevision('n1', 7);
    await tick();
    // The save is still in the outbox, so the server has not been asked.
    expect(api.restoreRevision).not.toHaveBeenCalled();

    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, title: 'typed', updatedAt: 200 });
    expect(await fake.replayOne()).toBe('done');
    expect(await restoring).toMatchObject({ note: { title: 'restored' } });
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
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: restored, kept: 9 });
    expect(await actions.restoreRevision('n1', 7)).toEqual({ note: restored, kept: 9 });
  });

  it('tells nobody of a write when the version was already the note', async () => {
    const { lib, note } = library([row('n1', { title: 'same' })]);
    await lib.outbox.ready;
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: note('n1'), kept: null });
    const heard = vi.fn();
    const off = actions.onDirectWrite(heard);
    expect((await actions.restoreRevision('n1', 7)).kept).toBeNull();
    off();
    expect(heard).not.toHaveBeenCalled();
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

  it('sends a newly typed field, reading the type from the library this tab still holds', async () => {
    // A library whose outbox is not durable does not queue, but it has the notebook's
    // definitions. Passing none used to skip Amount as a leftover id, so the autosave
    // reported "Saved" and the number existed nowhere but the draft — gone on the next
    // open.
    const { fake, note } = library([row('n1', { title: 'old', notebookId: 'nb1' })], [receipts]);
    fake.lead(false);
    const base = note('n1');
    vi.mocked(api.updateNote).mockResolvedValueOnce({
      ...base,
      fields: [{ fieldId: amount.id, name: 'Amount', type: 'number', value: 12.5, notebookId: 'nb1', notebook: 'Receipts' }],
      updatedAt: 101,
    });
    await actions.saveNote({
      noteId: 'n1',
      value: { ...seedFrom(base), fields: { [amount.id]: 12.5 } },
      base,
    });
    expect(api.updateNote).toHaveBeenCalledWith('n1', { fields: { [amount.id]: 12.5 }, ifUpdatedAt: 100 });
    expect(fake.queue).toHaveLength(0);
  });

  it('reads a field’s type from the library over the editor’s older copy of it', async () => {
    // The editor remembers Amount as text from before another tab converted it to a
    // number; the library has the conversion. Encoding from the editor's copy would
    // send "twelve" to a number field and 400 the title with it.
    const { fake, note } = library([row('n1', { title: 'old', notebookId: 'nb1' })], [receipts]);
    fake.lead(false);
    const base = note('n1');
    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...base, title: 'new', updatedAt: 101 });
    await actions.saveNote({
      noteId: 'n1',
      value: { ...seedFrom(base), title: 'new', fields: { [amount.id]: 'twelve' } },
      base,
      definitions: [{ ...amount, type: 'text' }],
    });
    expect(api.updateNote).toHaveBeenCalledWith('n1', { title: 'new', ifUpdatedAt: 100 });
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

  it('sends a newly typed field from the definitions the editor already loaded', async () => {
    // No OPFS on this device, so there is no library to read types from. The editor
    // still has them (`rememberFieldDefs`); without them Amount was skipped and the
    // title saved alone, then the reseed from that answer wiped the draft's number.
    provideLibrary(async () => null);
    const base: Note = { id: 'n1', title: 'old', body: '', tags: [], notebook: 'Receipts', createdAt: 1, updatedAt: 100, fields: [] };
    vi.mocked(api.updateNote).mockResolvedValue({ ...base, title: 'Invoice', updatedAt: 101 });
    await actions.saveNote({
      noteId: 'n1',
      value: { ...seedFrom(base), title: 'Invoice', fields: { [amount.id]: 12.5 } },
      base,
      definitions: [amount],
    });
    expect(api.updateNote).toHaveBeenCalledWith('n1', {
      title: 'Invoice',
      fields: { [amount.id]: 12.5 },
      ifUpdatedAt: 100,
    });
  });
});

describe('a note the copy does not hold yet', () => {
  const missing: Note = { id: 'n-missing', title: 'old', body: '', tags: [], notebook: null, createdAt: 1, updatedAt: 100, fields: [] };

  /** A library whose first copy is still walking: no snapshot has been taken. */
  function copying(notes: LocalNote[], notebooks: FeedNotebook[] = []) {
    const out = library(notes, notebooks);
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

  it('sends a newly typed field on that request, from the library’s definitions', async () => {
    // The note came from the server during the first walk; the notebook's definitions
    // can already be here. Skipping them used to save the title and drop Amount.
    const { fake } = copying([], [receipts]);
    vi.mocked(api.updateNote).mockResolvedValue({
      ...missing,
      title: 'new',
      fields: [{ fieldId: amount.id, name: 'Amount', type: 'number', value: 12.5, notebookId: 'nb1', notebook: 'Receipts' }],
      updatedAt: 101,
    });
    await actions.saveNote({
      noteId: missing.id,
      value: { ...seedFrom(missing), title: 'new', fields: { [amount.id]: 12.5 } },
      base: missing,
    });
    expect(api.updateNote).toHaveBeenCalledWith(missing.id, {
      title: 'new',
      fields: { [amount.id]: 12.5 },
      ifUpdatedAt: 100,
    });
    expect(fake.queue).toHaveLength(0);
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

  it('tags a held note as the server will: without case, and a tag in both lists added', async () => {
    const { lib } = library([{ ...row('n1'), tagNames: ['Receipts', 'Garden'] }]);
    await actions.tagNotes(['n1'], { add: ['receipts', 'Shed', 'SHED'], remove: ['GARDEN'] });
    await tick();
    expect(lib.notes.get('n1')?.tagNames).toEqual(['Receipts', 'Shed']);
    await actions.tagNotes(['n1'], { add: ['garden'], remove: ['Garden'] });
    await tick();
    expect(lib.notes.get('n1')?.tagNames).toEqual(['Receipts', 'Shed', 'garden']);
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

  /**
   * The plan's refusal keeps a queued upload as it keeps a save (MAK-108): the bytes on
   * the shelf are the one copy, and the answer changes when the person subscribes. The
   * upload's own error path builds the error, so this is the case that proves it carries
   * the code the outbox reads.
   */
  it('is kept, bytes and all, when the plan\'s 402 refuses it', async () => {
    const { lib, fake } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo());
    await tick();
    setReachableForTests(true);
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new ApiError(402, 'read-only', 'PLAN_INACTIVE'));
    expect(await fake.replayOne()).toBe('kept');
    expect(root.paths()).toEqual(['unbent-files-u1/pending/n1/photo.jpg']);
    expect(fake.queue.map((e) => e.mutationFnName)).toEqual(['uploadFile']);
    expect(lib.outbox.status().uploadNotices.size).toBe(0);
    expect(planLapsed()).toBe(true);
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

  it('keeps the file through a lost connection, a server that is down, a refused session, a timeout and a rate limit', async () => {
    const { fake } = library([row('n1')]);
    setReachableForTests(false);
    await actions.uploadFile('n1', photo());
    await tick();
    for (const err of [
      new OfflineError(),
      new ApiError(503, 'Unavailable'),
      new ApiError(401, 'Unauthorized'),
      new ApiError(408, 'Timeout'),
      new ApiError(429, 'Too Many Requests'),
    ]) {
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

describe('applying a notebook template', () => {
  const definition = { name: 'Receipts', fields: [{ name: 'Vendor', type: 'text' as const }] };

  it('waits for the library to hold the notebook before answering, when the copy is whole', async () => {
    vi.mocked(api.importNotebook).mockResolvedValueOnce({ id: 'nb', skipped: [] });
    const { engine, landPull } = library([]);
    let answered = false;
    const done = actions.applyNotebookTemplate(definition, { create: true }).then(() => (answered = true));
    await tick();
    await tick();
    expect(engine.pull).toHaveBeenCalledOnce();
    expect(answered).toBe(false);
    landPull();
    await done;
    expect(api.importNotebook).toHaveBeenCalledWith(definition, { create: true });
  });

  it('asks for the pull without waiting on it while the copy is not whole', async () => {
    vi.mocked(api.importNotebook).mockResolvedValueOnce({ id: 'nb', skipped: [] });
    const { engine } = library([]);
    // A first copy cut short: the pull would resume the whole walk.
    engine.state.phase = 'failed';
    engine.state.cursor = null;
    await expect(actions.applyNotebookTemplate(definition, { create: true })).resolves.toEqual({ id: 'nb', skipped: [] });
    expect(engine.pull).toHaveBeenCalledOnce();
  });

  it('pulls nothing for a name the server refused, since nothing was written', async () => {
    vi.mocked(api.importNotebook).mockResolvedValueOnce('taken');
    const { engine } = library([]);
    await expect(actions.applyNotebookTemplate(definition, { create: true })).resolves.toBe('taken');
    expect(engine.pull).not.toHaveBeenCalled();
  });
});

/*
 * The writes the person makes here, told apart from everything else that changes the rows:
 * the interface rolls a count and moves a list row for these and not for the feed's.
 */
describe('a write made here', () => {
  it('is heard before it reaches the row, so a list can still measure where the row was', async () => {
    const { lib } = library([row('n1')]);
    await lib.outbox.ready;
    const seenBefore: Array<number | undefined> = [];
    const writes: actions.LocalWrite[] = [];
    const stop = actions.onLocalWrite((write) => {
      seenBefore.push(lib.notes.get('n1')?.deletedAt);
      writes.push(write);
    });
    await actions.trashNote('n1');
    stop();
    expect(seenBefore).toEqual([undefined]);
    expect(writes).toEqual([{ ids: ['n1'], refiles: true }]);
    expect(lib.notes.get('n1')?.deletedAt).toBeDefined();
    expect(actions.refiledLocallyWithin(1000)).toBe(true);
  });

  it('is heard when it goes as a request too', async () => {
    // A note the first copy has not reached yet goes as a request.
    const { engine } = library([]);
    engine.state.cursor = null;
    vi.mocked(api.deleteNote).mockResolvedValueOnce(undefined);
    const heard = vi.fn();
    const stop = actions.onLocalWrite(heard);
    await actions.trashNote('n1');
    stop();
    expect(heard).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenCalledWith({ ids: ['n1'], refiles: true });
  });

  it('is not heard for a request the server refused, which wrote nothing', async () => {
    const { engine } = library([]);
    engine.state.cursor = null;
    vi.mocked(api.deleteNote).mockRejectedValueOnce(new ApiError(403, 'refused'));
    const heard = vi.fn();
    const stop = actions.onLocalWrite(heard);
    await expect(actions.trashNote('n1')).rejects.toThrow('refused');
    stop();
    expect(heard).not.toHaveBeenCalled();
  });

  it('says a save of the text cannot refile the note, and a save of its notebook can', async () => {
    const { lib, note } = library([row('n1')]);
    await lib.outbox.ready;
    const writes: actions.LocalWrite[] = [];
    const stop = actions.onLocalWrite((write) => writes.push(write));
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'retyped' }, base });
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'retyped', notebook: 'Elsewhere' }, base });
    stop();
    expect(writes).toEqual([
      { ids: ['n1'], refiles: false },
      { ids: ['n1'], refiles: true },
    ]);
  });

  it('includes emptying the trash, which names the trashed notes the list is showing', async () => {
    const { engine } = library([row('n1'), row('n2')]);
    vi.mocked(api.purgeNotes).mockResolvedValueOnce({ notesDeleted: 2 } as api.PurgeResult);
    const heard = vi.fn();
    const stop = actions.onLocalWrite(heard);
    await expect(actions.emptyTrash(['n1', 'n2'])).resolves.toMatchObject({ notesDeleted: 2 });
    stop();
    expect(api.purgeNotes).toHaveBeenCalledWith('trashed');
    expect(heard).toHaveBeenCalledWith({ ids: ['n1', 'n2'], refiles: true });
    expect(engine.pull).toHaveBeenCalled();
  });

  it('opens the window a count rolls in only for a write that can move one', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const { lib, note } = library([row('n1')]);
      await lib.outbox.ready;
      // Far past any refile an earlier test made on the real clock.
      vi.advanceTimersByTime(1e9);
      const base = note('n1');
      await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'retyped' }, base });
      expect(actions.refiledLocallyWithin(1000)).toBe(false);
      await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'retyped', notebook: 'Elsewhere' }, base });
      expect(actions.refiledLocallyWithin(1000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A tab that is a client of the tab holding the library (`client-library.ts`): its writes
 * are sent to the holder by name rather than run here, and are heard here as writes made
 * here, before they go. A call refused because the library moved — this tab became the
 * holder with the call in hand — is made again where the library now is.
 */
describe('a tab that is a client of the holder', () => {
  afterEach(() => provideForwarder(async () => null));

  it('sends a write to the holder by name, and is heard before it goes', async () => {
    const { lib } = library([row('n1')]);
    await lib.outbox.ready;
    const sent: Array<[string, unknown[]]> = [];
    provideForwarder(async () => async (name, args) => {
      sent.push([name, args]);
      return `${name} done`;
    });
    const heard = vi.fn();
    const stop = actions.onLocalWrite(heard);
    await expect(actions.trashNote('n1')).resolves.toBe('trashNote done');
    stop();
    expect(sent).toEqual([['trashNote', ['n1']]]);
    expect(heard).toHaveBeenCalledWith({ ids: ['n1'], refiles: true });
    // Nothing ran here: the row is as it was, and the outbox has nothing.
    expect(lib.notes.get('n1')?.deletedAt).toBeUndefined();
    expect(lib.outbox.status().pending).toBe(0);
  });

  it('says whether a forwarded save can refile the note', async () => {
    const { note } = library([row('n1')]);
    provideForwarder(async () => async () => 'queued');
    const writes: actions.LocalWrite[] = [];
    const stop = actions.onLocalWrite((write) => writes.push(write));
    const base = note('n1');
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), title: 'retyped' }, base });
    await actions.saveNote({ noteId: 'n1', value: { ...seedFrom(base), tags: ['new'] }, base });
    stop();
    expect(writes).toEqual([
      { ids: ['n1'], refiles: false },
      { ids: ['n1'], refiles: true },
    ]);
  });

  it('does the write here when the call was refused because the library moved to this tab', async () => {
    const { lib } = library([row('n1')]);
    await lib.outbox.ready;
    let calls = 0;
    provideForwarder(async () => {
      // The first ask finds a client whose holder is gone; by the second this tab holds the library.
      if (calls++ > 0) return null;
      return async () => {
        throw new LibraryMovedError(true);
      };
    });
    await actions.trashNote('n1');
    expect(lib.notes.get('n1')?.deletedAt).toBeDefined();
    expect(lib.outbox.status().pending).toBe(1);
  });

  it('mints the id of a note, a copy or a file here and sends it with the call, so a call run twice makes one', async () => {
    library([row('n1')]);
    const sent: Array<[string, unknown[]]> = [];
    provideForwarder(async () => async (name, args) => {
      sent.push([name, args]);
      return { id: 'x' };
    });
    const file = new File(['x'], 'scan.pdf', { type: 'application/pdf' });
    await actions.createNote({ title: 't', body: '', tags: [], notebook: null });
    await actions.duplicateNote('n1');
    await actions.uploadFile('n1', file);
    expect(sent.map(([name]) => name)).toEqual(['createNote', 'duplicateNote', 'uploadFile']);
    const uuid = /^[0-9a-f-]{36}$/;
    expect(sent[0]![1][1]).toMatch(uuid);
    expect(sent[1]![1][1]).toMatch(uuid);
    expect(sent[2]![1][2]).toMatch(uuid);
    // The holder runs the same function with the id it was sent.
    vi.mocked(api.createNote).mockResolvedValueOnce({ id: 'given' } as Note);
    provideLibrary(async () => null);
    provideForwarder(async () => null);
    await actions.createNote({ title: 't', body: '', tags: [], notebook: null }, 'given');
    expect(api.createNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'given' }));
  });

  it('tells the list about emptying the trash once the holder has answered, and not for a refusal', async () => {
    library([row('n1')]);
    let answer: () => void = () => {};
    provideForwarder(async () => async () => new Promise((resolve) => (answer = () => resolve({ notesDeleted: 1 }))));
    const heard = vi.fn();
    const stop = actions.onLocalWrite(heard);
    const emptying = actions.emptyTrash(['n1']);
    await Promise.resolve();
    await Promise.resolve();
    expect(heard).not.toHaveBeenCalled();
    answer();
    await expect(emptying).resolves.toMatchObject({ notesDeleted: 1 });
    expect(heard).toHaveBeenCalledWith({ ids: ['n1'], refiles: true });
    provideForwarder(async () => async () => {
      throw new ApiError(403, 'refused');
    });
    await expect(actions.emptyTrash(['n1'])).rejects.toThrow('refused');
    stop();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('does not empty the trash again after a holder had the call and went', async () => {
    library([row('n1')]);
    provideForwarder(async () => async () => {
      throw new LibraryMovedError(true);
    });
    await expect(actions.emptyTrash(['n1'])).rejects.toBeInstanceOf(CallUnsettledError);
    expect(api.purgeNotes).not.toHaveBeenCalled();
    // One the holder never had is done here.
    provideForwarder(async () => async () => {
      throw new LibraryMovedError(false);
    });
    vi.mocked(api.purgeNotes).mockResolvedValueOnce({ notesDeleted: 1 } as api.PurgeResult);
    await expect(actions.emptyTrash(['n1'])).resolves.toMatchObject({ notesDeleted: 1 });
  });

  it('does not do the thing again here when the account changed under the call', async () => {
    const { lib } = library([row('n1')]);
    await lib.outbox.ready;
    provideForwarder(async () =>
      Object.assign(
        async () => {
          throw new LibraryMovedError(false);
        },
        { stillMine: () => false },
      ),
    );
    await expect(actions.trashNote('n1')).rejects.toThrow('account on this tab changed');
    expect(lib.notes.get('n1')?.deletedAt).toBeUndefined();
    expect(lib.outbox.status().pending).toBe(0);
  });

  it('brings any other failure back to the caller as it came', async () => {
    library([row('n1')]);
    provideForwarder(async () => async () => {
      throw new ApiError(404, 'Not found');
    });
    await expect(actions.trashNote('n1')).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * The outbox's database being deleted under it, by a sign-out in another tab. IndexedDB
 * tells every open connection through `versionchange`; the connection has to close for
 * the delete to go through, and the library is told so it closes with the outbox.
 */
describe('the outbox’s connection', () => {
  it('closes when another tab deletes the database, and tells the library', async () => {
    const onAskedToClose = vi.fn();
    const { lib } = library([row('n1', { title: 'a' })]);
    const outbox = createOutbox('u1', lib, { onAskedToClose });
    const adapter = MemoryAdapter.instances[MemoryAdapter.instances.length - 1]!;
    // Not open at init in a tab that does not lead; the outbox's own first read opens it.
    expect(adapter.db).toBeNull();
    await outbox.ready;
    expect(adapter.db?.onversionchange).toBeTypeOf('function');
    adapter.db!.onversionchange!();
    expect(adapter.db!.closed).toBe(true);
    expect(onAskedToClose).toHaveBeenCalledTimes(1);
  });
});
