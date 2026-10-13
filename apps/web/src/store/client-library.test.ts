import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollection, type Collection } from '@tanstack/db';
import type { FeedNote, FeedNotebook, FeedTag, FeedAttachment } from '@unbent/shared';
import { ApiError, NoteChangedError, OfflineError } from '../notes-api.js';
import { attachClientLibrary, ATTACH_STALL_MS, CallUnsettledError, HELLO_RETRY_MAX_MS, HELLO_RETRY_MS, HOLDER_SILENT_MS, LibraryMovedError, ORPHANED_MS, PING_MS, type ClientHooks, type ClientLibrary } from './client-library.js';
import { serveLibrary, HELLO_DEDUPE_MS, ROWS_PER_MESSAGE, type Serving, type Server } from './library-serve.js';
import { carry, revive, type Message, type Port } from './library-channel.js';
import { LIBRARY_ROOTS } from './library-roots.js';
import { fakeChannel } from './test-channel.js';
import type { FeedState } from './feed.js';
import type { SyncStatus } from './actions.js';
import type { KeepStatus } from './keep.js';

vi.mock('./actions.js', () => ({
  forwardable: {
    trashNote: vi.fn(async (noteId: string) => `trashed ${noteId}`),
    emptyTrash: vi.fn(async () => ({ notesDeleted: 1 })),
    saveNote: vi.fn(async () => {
      throw new NoteChangedError({ id: 'n1', title: 'theirs', body: '', tags: [], notebook: null, createdAt: 1, updatedAt: 9, fields: [] } as never);
    }),
  },
}));
import { forwardable } from './actions.js';

/**
 * The channel between the tab holding the library and the account's other tabs
 * (`library-channel.ts`): a holder served from collections in memory, a client attached
 * over the fake channel, and what crosses between them — the rows once, the changes
 * after, the statuses, the calls and their answers — and what happens when the holder
 * goes.
 */

/** A collection a test fills through its sync path, as a feed page or a queued write would. */
function collection<T extends object>(id: string, seed: T[]): Collection<T, string> & { upsert: (row: T) => void; remove: (id: string) => void } {
  let controls!: { begin: () => void; write: (m: { type: 'insert' | 'update'; value: T } | { type: 'delete'; key: string }) => void; commit: () => unknown };
  const c = createCollection<T, string>({
    id: `${id}-${Math.random().toString(36).slice(2)}`,
    getKey: (row) => (row as { id: string }).id,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        controls = { begin, write, commit };
        begin();
        for (const row of seed) write({ type: 'insert', value: row });
        commit();
        markReady();
      },
    },
  });
  return Object.assign(c, {
    upsert: (row: T) => {
      controls.begin();
      controls.write({ type: c.has((row as { id: string }).id) ? 'update' : 'insert', value: row });
      controls.commit();
    },
    remove: (key: string) => {
      controls.begin();
      controls.write({ type: 'delete', key });
      controls.commit();
    },
  });
}

const note = (id: string, title = id): FeedNote => ({ id, title, body: `body of ${id}`, createdAt: 1, updatedAt: 1, tagIds: [], notebookId: null, fields: [], files: [] });
const state = (over: Partial<FeedState> = {}): FeedState => ({ phase: 'current', cursor: { seq: 5, epoch: 'e' }, lastError: null, total: null, applied: 0, pulls: 1, resets: 0, ...over });
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({ pending: 0, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map(), ...over });
const keeping = (over: Partial<KeepStatus> = {}): KeepStatus => ({ supported: true, kept: new Set(['nb1']), counted: true, wanted: { files: 2, bytes: 20 }, have: { files: 1, bytes: 10 }, fetching: false, problem: null, ...over });

/** A holder: collections in memory and stand-ins for the engine's state, the outbox and the keeper, each with a way to move. */
function holder(port: Port, rows: { notes?: FeedNote[]; notebooks?: FeedNotebook[]; tags?: FeedTag[]; attachments?: FeedAttachment[] } = {}, opts: { index?: boolean } = {}) {
  const notes = collection<FeedNote>('notes', rows.notes ?? []);
  const notebooks = collection<FeedNotebook>('notebooks', rows.notebooks ?? []);
  const tags = collection<FeedTag>('tags', rows.tags ?? []);
  const attachments = collection<FeedAttachment>('attachments', rows.attachments ?? []);
  let feed = state();
  const feedListeners = new Set<(s: FeedState) => void>();
  let sync = status();
  const syncListeners = new Set<(s: SyncStatus) => void>();
  const acks = new Set<(id: string, note: unknown, sent: unknown) => void>();
  let keep = keeping();
  const keepListeners = new Set<(s: KeepStatus) => void>();
  const index = { candidates: vi.fn(async () => [{ id: 'n1', rank: 1 }]), snippets: vi.fn(async () => new Map([['n1', 'snip']])), meta: vi.fn(async () => 'yes'), held: vi.fn(async () => 1) };
  const sync_ = { opened: vi.fn(async () => {}) };
  const keeper = { status: () => keep, subscribe: (l: (s: KeepStatus) => void) => (keepListeners.add(l), l(keep), () => void keepListeners.delete(l)), keep: vi.fn(async () => {}), release: vi.fn(async () => {}), releaseAll: vi.fn(async () => {}), nudge: () => {}, stop: () => {} };
  const outbox = {
    status: () => sync,
    subscribe: (l: (s: SyncStatus) => void) => (syncListeners.add(l), l(sync), () => void syncListeners.delete(l)),
    onAcknowledged: (l: (id: string, note: unknown, sent: unknown) => void) => (acks.add(l), () => void acks.delete(l)),
    resolveConflict: vi.fn(),
    dismissUploadNotices: vi.fn(),
    cancelUpload: vi.fn(async () => 'cancelled' as const),
  };
  const serving: Serving = {
    collections: { notes, notebooks, tags, attachments, syncState: null as never },
    state: () => feed,
    onState: (l) => (feedListeners.add(l), () => void feedListeners.delete(l)),
    outbox: outbox as never,
    keeper,
    search: () => (opts.index === false ? null : { index: index as never, sync: sync_ as never }),
    searchReady: Promise.resolve(),
  };
  const server: Server = serveLibrary(port, serving);
  return {
    server,
    notes,
    notebooks,
    tags,
    attachments,
    index,
    sync_,
    keeper,
    outbox,
    moveFeed: (over: Partial<FeedState>) => {
      feed = state(over);
      feedListeners.forEach((l) => l(feed));
    },
    moveSync: (over: Partial<SyncStatus>) => {
      sync = status(over);
      syncListeners.forEach((l) => l(sync));
    },
    moveKeep: (over: Partial<KeepStatus>) => {
      keep = keeping(over);
      keepListeners.forEach((l) => l(keep));
    },
    acknowledge: (id: string, note: unknown, sent: unknown) => acks.forEach((l) => l(id, note, sent)),
  };
}

function hooks(): ClientHooks & { changes: ReadonlySet<string>[]; attached: number; resets: number; indexed: number; silent: number } {
  const h = {
    changes: [] as ReadonlySet<string>[],
    attached: 0,
    resets: 0,
    indexed: 0,
    silent: 0,
    onChange: (roots: ReadonlySet<string>) => void h.changes.push(roots),
    onAttached: () => void (h.attached += 1),
    onReset: () => void (h.resets += 1),
    onIndexed: () => void (h.indexed += 1),
    onSilent: () => void (h.silent += 1),
  };
  return h;
}

/** Lets every microtask the fake channel queued run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('a client of the holding tab', () => {
  let channel: ReturnType<typeof fakeChannel>;
  const open: ClientLibrary[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    channel = fakeChannel();
  });
  afterEach(async () => {
    for (const lib of open.splice(0)) await lib.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** A client with its own id, its port opened for it. */
  const attach = (h = hooks(), halting = new AbortController()) => {
    const me = crypto.randomUUID();
    return attachClientLibrary('u1', me, channel.port(me), h, halting.signal);
  };
  async function client(h = hooks(), halting = new AbortController()) {
    const attaching = attach(h, halting);
    await settle();
    const lib = await attaching;
    open.push(lib);
    return lib;
  }

  it('mirrors the holder’s rows, state and statuses on attach, and derives from the rows', async () => {
    const h = holder(channel.port(), { notes: [note('n1'), note('n2')], tags: [{ id: 't1', name: 'tax' }] });
    h.moveFeed({ applied: 7 });
    const hk = hooks();
    const lib = await client(hk);
    expect(lib.remote).toBe(true);
    expect(lib.attached()).toBe(true);
    expect([...lib.notes.values()].map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(lib.notes.get('n2')?.body).toBe('body of n2');
    expect(lib.notes.has('n3')).toBe(false);
    expect(lib.tags.size).toBe(1);
    expect(lib.notebooks.size).toBe(0);
    expect(lib.state().applied).toBe(7);
    expect(lib.outbox.status().durable).toBe(true);
    expect(lib.keeper.status().kept.has('nb1')).toBe(true);
    expect(hk.attached).toBe(1);
    // The rows are the holder's by value, as the browser would clone them, not by reference.
    expect(lib.notes.get('n1')).not.toBe(h.notes.get('n1'));
    expect(lib.notes.get('n1')).toEqual(h.notes.get('n1'));
  });

  it('sends a large collection in chunks and the client holds all of it', async () => {
    const many = Array.from({ length: ROWS_PER_MESSAGE * 2 + 5 }, (_, i) => note(`n${i}`));
    holder(channel.port(), { notes: many });
    const lib = await client();
    expect(lib.notes.size).toBe(many.length);
    expect(channel.posted.filter((m) => m.type === 'rows' && m.entity === 'note')).toHaveLength(3);
  });

  it('follows the holder’s changes, with the roots each batch reaches, and the version moves', async () => {
    const h = holder(channel.port(), { notes: [note('n1')] });
    const hk = hooks();
    const lib = await client(hk);
    const before = lib.version();
    hk.changes.length = 0;
    // A change of text alone reaches the list and the note — from the second change to a
    // row on: the collection reports the first change to a row a subscription has not
    // seen as an insert with no previous value, which reaches everything, in the holder's
    // own tab as much as here.
    h.notes.upsert({ ...note('n1'), title: 'renamed', updatedAt: 2 });
    await settle();
    h.notes.upsert({ ...note('n1'), title: 'renamed again', updatedAt: 3 });
    await settle();
    expect(lib.notes.get('n1')?.title).toBe('renamed again');
    expect(lib.version()).toBeGreaterThan(before);
    expect(hk.changes).toHaveLength(2);
    expect([...hk.changes[1]!].sort()).toEqual(['note', 'notes']);
    hk.changes.length = 0;
    // A row arriving reaches everything; a row going too. Three changes in one task
    // cross as one message, and the client derives once for them.
    h.notes.upsert(note('n2'));
    h.tags.upsert({ id: 't1', name: 'tax' });
    h.notes.remove('n1');
    await settle();
    expect([...lib.notes.values()].map((n) => n.id)).toEqual(['n2']);
    expect(lib.tags.get('t1')?.name).toBe('tax');
    expect(hk.changes).toHaveLength(1);
    expect(hk.changes[0]!.size).toBe(LIBRARY_ROOTS.size);
    expect(channel.posted.filter((m) => m.type === 'changes').at(-1)).toMatchObject({ batches: [{ entity: 'note' }, { entity: 'tag' }, { entity: 'note' }] });
  });

  it('mirrors the feed’s state, the outbox’s status, the keeper’s, acknowledgements and the index moving', async () => {
    const h = holder(channel.port());
    const hk = hooks();
    const lib = await client(hk);
    const feeds: FeedState[] = [];
    const syncs: SyncStatus[] = [];
    const keeps: KeepStatus[] = [];
    const acked: unknown[] = [];
    lib.subscribe((s) => feeds.push(s));
    lib.outbox.subscribe((s) => syncs.push(s));
    lib.keeper.subscribe((s) => keeps.push(s));
    lib.outbox.onAcknowledged((id, n, sent) => acked.push([id, n, sent]));
    // Each subscribe answered at once with what is held, as the holder's do.
    expect(feeds).toHaveLength(1);
    expect(syncs).toHaveLength(1);
    expect(keeps).toHaveLength(1);
    h.moveFeed({ phase: 'hydrating', applied: 3 });
    h.moveSync({ pending: 2, waiting: new Set(['n1']) });
    h.moveKeep({ fetching: true });
    h.acknowledge('n1', { id: 'n1' }, { title: 't' });
    h.server.indexed();
    await settle();
    expect(lib.state().phase).toBe('hydrating');
    expect(feeds.at(-1)?.applied).toBe(3);
    expect(lib.outbox.status().pending).toBe(2);
    expect(lib.outbox.status().waiting.has('n1')).toBe(true);
    expect(lib.keeper.status().fetching).toBe(true);
    expect(acked).toEqual([['n1', { id: 'n1' }, { title: 't' }]]);
    expect(hk.indexed).toBe(1);
  });

  it('empties its rows on the holder’s reset and fills again from the inserts that follow', async () => {
    const h = holder(channel.port(), { notes: [note('n1')] });
    const hk = hooks();
    const lib = await client(hk);
    h.server.reset();
    await settle();
    expect(lib.notes.size).toBe(0);
    expect(hk.resets).toBe(1);
    h.notes.upsert({ ...note('n1'), title: 'back', updatedAt: 2 });
    await settle();
    expect(lib.notes.size).toBe(1);
  });

  it('runs a write on the holder by name and answers with its result', async () => {
    holder(channel.port());
    const lib = await client();
    const answer = lib.call('trashNote', ['n1']);
    await settle();
    await expect(answer).resolves.toBe('trashed n1');
    expect(forwardable.trashNote).toHaveBeenCalledWith('n1');
  });

  it('still answers a call that was running when the holder stopped', async () => {
    let finish!: (v: string) => void;
    vi.mocked(forwardable.trashNote!).mockImplementationOnce(() => new Promise<string>((r) => (finish = r)) as never);
    const h = holder(channel.port());
    const lib = await client();
    const answer = lib.call('trashNote', ['n1']);
    await settle();
    h.server.stop();
    finish('trashed late');
    await settle();
    await expect(answer).resolves.toBe('trashed late');
  });

  it('brings a failure back as the class it was', async () => {
    holder(channel.port());
    const lib = await client();
    const answer = lib.call('saveNote', [{}]);
    answer.catch(() => {});
    await settle();
    await expect(answer).rejects.toBeInstanceOf(NoteChangedError);
    await expect(answer).rejects.toMatchObject({ current: { title: 'theirs' } });
    const unknown = lib.call('noSuchThing', []);
    unknown.catch(() => {});
    await settle();
    await expect(unknown).rejects.toThrow('No such call: noSuchThing');
  });

  it('asks the holder’s index, keeper and outbox by name, and only what is listed', async () => {
    const h = holder(channel.port());
    const lib = await client();
    const candidates = lib.search.index.candidates('note', 'tax', 50);
    const snippets = lib.search.index.snippets('note', 'tax', ['n1']);
    const meta = lib.search.index.meta('built');
    const held = lib.search.index.held('file', ['f1']);
    const opened = lib.search.sync.opened('n1');
    const kept = lib.keeper.keep('nb2');
    const cancelled = lib.outbox.cancelUpload('a1');
    lib.outbox.resolveConflict('n1');
    lib.outbox.dismissUploadNotices('n1');
    await settle();
    await settle();
    await expect(candidates).resolves.toEqual([{ id: 'n1', rank: 1 }]);
    await expect(snippets).resolves.toEqual(new Map([['n1', 'snip']]));
    await expect(meta).resolves.toBe('yes');
    await expect(held).resolves.toBe(1);
    await opened;
    await kept;
    await expect(cancelled).resolves.toBe('cancelled');
    expect(h.index.candidates).toHaveBeenCalledWith('note', 'tax', 50);
    expect(h.sync_.opened).toHaveBeenCalledWith('n1');
    expect(h.keeper.keep).toHaveBeenCalledWith('nb2');
    expect(h.outbox.resolveConflict).toHaveBeenCalledWith('n1');
    expect(h.outbox.dismissUploadNotices).toHaveBeenCalledWith('n1');
    // The index's writes are the holder's sync's, not a client's to ask for.
    const put = lib.call('index.put', ['note', []]);
    put.catch(() => {});
    await settle();
    await expect(put).rejects.toThrow('No such call: index.put');
  });

  it('answers a search with no index as offline', async () => {
    holder(channel.port(), {}, { index: false });
    const lib = await client();
    const asked = lib.search.index.meta('built');
    asked.catch(() => {});
    await settle();
    await expect(asked).rejects.toBeInstanceOf(OfflineError);
  });

  it('keeps saying hello, less and less often, until a holder serves, and attaches to one that starts later', async () => {
    const hk = hooks();
    const halting = new AbortController();
    const attaching = attach(hk, halting);
    let attached = false;
    void attaching.then(() => (attached = true));
    const hellos = () => channel.posted.filter((m) => m.type === 'hello').length;
    await vi.advanceTimersByTimeAsync(HELLO_RETRY_MS * 3);
    expect(attached).toBe(false);
    // At once, after two seconds, after four more: three in six seconds.
    expect(hellos()).toBe(3);
    await vi.advanceTimersByTimeAsync(HELLO_RETRY_MAX_MS * 4);
    // Capped at one every thirty seconds.
    expect(hellos()).toBeLessThan(12);
    holder(channel.port(), { notes: [note('n1')] });
    await settle();
    await settle();
    const lib = await attaching;
    open.push(lib);
    expect(attached).toBe(true);
    expect(lib.notes.size).toBe(1);
    // Attached: the asking stops.
    const asked = hellos();
    await vi.advanceTimersByTimeAsync(HELLO_RETRY_MAX_MS * 2);
    expect(hellos()).toBe(asked);
  });

  it('keeps its rows and holds its calls when the holder closes, and attaches to the next holder, which answers them', async () => {
    const first = holder(channel.port(), { notes: [note('n1')] });
    const hk = hooks();
    const lib = await client(hk);
    first.server.stop();
    await settle();
    expect(lib.attached()).toBe(false);
    // The rows stay, the reads keep working, and a write waits.
    expect(lib.notes.size).toBe(1);
    const waiting = lib.call('trashNote', ['n1']);
    await vi.advanceTimersByTimeAsync(HELLO_RETRY_MS);
    expect(forwardable.trashNote).not.toHaveBeenCalled();
    // A change the old holder posts after closing is not this client's.
    first.notes.upsert(note('n9'));
    await settle();
    expect(lib.notes.size).toBe(1);
    // The next holder serves: the client attaches to it, with its rows, and the call goes.
    holder(channel.port(), { notes: [note('n1'), note('n2')] });
    await settle();
    await settle();
    expect(lib.attached()).toBe(true);
    expect(lib.notes.size).toBe(2);
    expect(hk.attached).toBe(2);
    await expect(waiting).resolves.toBe('trashed n1');
  });

  it('sends a call in hand once to a holder that attaches it twice, and stops asking once rows arrive', async () => {
    holder(channel.port(), { notes: [note('n1')] });
    const lib = await client();
    const hellos = () => channel.posted.filter((m) => m.type === 'hello');
    const attachedTimes = () => channel.posted.filter((m) => m.type === 'attached').length;
    expect(hellos()).toHaveLength(1);
    expect(attachedTimes()).toBe(1);
    // A second hello from this client reaches the holder — one sent before the first
    // answer arrived, say — once the holder's dedupe window has passed.
    vi.setSystemTime(Date.now() + HELLO_DEDUPE_MS + 1);
    const waiting = lib.call('trashNote', ['n1']);
    channel.port().post(hellos()[0]!);
    await settle();
    await settle();
    expect(attachedTimes()).toBe(2);
    await expect(waiting).resolves.toBe('trashed n1');
    expect(forwardable.trashNote).toHaveBeenCalledTimes(1);
    // And one inside the window is not answered at all.
    channel.port().post(hellos()[0]!);
    await settle();
    expect(attachedTimes()).toBe(2);
  });

  it('asks again only when a holder’s rows stop short of attached', async () => {
    const halting = new AbortController();
    const attaching = attach(hooks(), halting);
    attaching.catch(() => {});
    const hellos = () => channel.posted.filter((m): m is Extract<Message, { type: 'hello' }> => m.type === 'hello');
    const me = hellos()[0]!.client;
    // A holder's rows start to arrive, and stop: the holder closed mid-send.
    channel.port().post({ type: 'rows', holder: 'ghost', client: me, entity: 'note', rows: [] });
    await settle();
    const before = hellos().length;
    await vi.advanceTimersByTimeAsync(HELLO_RETRY_MS * 3);
    expect(hellos()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(ATTACH_STALL_MS);
    expect(hellos().length).toBeGreaterThan(before);
    halting.abort();
  });

  it('pings its holder only while a call is in hand, and asks to take the library over from one that stops answering', async () => {
    const port = channel.port();
    holder(port, { notes: [note('n1')] });
    const hk = hooks();
    const lib = await client(hk);
    const pings = () => channel.posted.filter((m) => m.type === 'ping').length;
    const pongs = () => channel.posted.filter((m) => m.type === 'pong').length;
    // Idle: nothing is asked of anyone.
    await vi.advanceTimersByTimeAsync(PING_MS * 3 + 10);
    expect(pings()).toBe(0);
    // A call in hand: pinged until it is answered, then quiet again.
    let finish!: (v: string) => void;
    vi.mocked(forwardable.trashNote!).mockImplementationOnce(() => new Promise<string>((r) => (finish = r)) as never);
    const slow = lib.call('trashNote', ['n1']);
    await settle();
    await vi.advanceTimersByTimeAsync(PING_MS * 3 + 10);
    expect(pings()).toBe(3);
    expect(pongs()).toBe(3);
    finish('trashed n1');
    await expect(slow).resolves.toBe('trashed n1');
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(pings()).toBe(3);
    expect(hk.silent).toBe(0);
    // Pinged again, with a call in hand, through a throttled interval.
    vi.mocked(forwardable.trashNote!).mockImplementationOnce(() => new Promise<string>(() => {}) as never);
    lib.call('trashNote', ['n1']).catch(() => {});
    await settle();
    // A hidden client's interval runs once a minute: a live, idle holder is not silent.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 60_000 - PING_MS);
      await vi.advanceTimersByTimeAsync(PING_MS);
    }
    expect(hk.silent).toBe(0);
    expect(lib.attached()).toBe(true);
    // The holder's tab is frozen: it hears nothing and says nothing, and still holds the
    // lock. With a call in hand, the client takes the library over.
    port.close();
    await vi.advanceTimersByTimeAsync(HOLDER_SILENT_MS + PING_MS * 2);
    expect(hk.silent).toBe(1);
    expect(lib.attached()).toBe(false);
    // The rows stay readable meanwhile, and a call waits for whatever comes next.
    expect(lib.notes.size).toBe(1);
    await vi.advanceTimersByTimeAsync(PING_MS * 4);
    expect(hk.silent).toBe(1);
  });

  it('asks to take the library over when no holder serves for long after the last one closed', async () => {
    const h = holder(channel.port(), { notes: [note('n1')] });
    const hk = hooks();
    const lib = await client(hk);
    h.server.stop();
    await settle();
    // Nothing to send: nothing to take over for, however long nobody serves.
    await vi.advanceTimersByTimeAsync(ORPHANED_MS * 2);
    expect(hk.silent).toBe(0);
    const waiting = lib.call('trashNote', ['n1']);
    waiting.catch(() => {});
    await vi.advanceTimersByTimeAsync(ORPHANED_MS / 2);
    expect(hk.silent).toBe(0);
    await vi.advanceTimersByTimeAsync(ORPHANED_MS / 2 + 10);
    expect(hk.silent).toBe(1);
    // A next holder that does serve in time is waited for, and the watch stops with it.
    const again = holder(channel.port(), { notes: [note('n1')] });
    await settle();
    await settle();
    expect(lib.attached()).toBe(true);
    await expect(waiting).resolves.toBe('trashed n1');
    again.server.stop();
    await settle();
    holder(channel.port(), { notes: [note('n1')] });
    await settle();
    await settle();
    await vi.advanceTimersByTimeAsync(ORPHANED_MS + 10);
    expect(hk.silent).toBe(1);
  });

  it('waits for a holder whose rows are still arriving, however slowly', async () => {
    const h = holder(channel.port(), { notes: [note('n1')] });
    const hk = hooks();
    const lib = await client(hk);
    const me = channel.posted.find((m): m is Extract<Message, { type: 'hello' }> => m.type === 'hello')!.client;
    h.server.stop();
    await settle();
    const waiting = lib.call('trashNote', ['n1']);
    waiting.catch(() => {});
    // The next holder opens slowly, then sends the library a chunk at a time, each
    // chunk further apart than the bound allows from `closing` alone.
    await vi.advanceTimersByTimeAsync(ORPHANED_MS - 1000);
    const ghost = channel.port();
    ghost.post({ type: 'serving', holder: 'slow' });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(ORPHANED_MS / 2);
      ghost.post({ type: 'rows', holder: 'slow', client: me, entity: 'note', rows: [note(`n${i}`)] });
      await settle();
    }
    expect(hk.silent).toBe(0);
    expect(lib.attached()).toBe(false);
  });

  it('refuses, rather than re-sends, a call that must not run twice once it has reached a holder', async () => {
    let finish!: (v: unknown) => void;
    vi.mocked(forwardable.emptyTrash!).mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    const first = holder(channel.port());
    const lib = await client();
    const emptying = lib.call('emptyTrash', [['n1']]);
    emptying.catch(() => {});
    const neverSent = lib.call('trashNote', ['n2']);
    await settle();
    // The holder goes without answering; the next one serves.
    first.server.stop();
    first.notes.upsert(note('x'));
    holder(channel.port());
    await settle();
    await settle();
    await expect(emptying).rejects.toBeInstanceOf(CallUnsettledError);
    expect(forwardable.emptyTrash).toHaveBeenCalledTimes(1);
    // A call that is safe twice, or never reached the old holder, goes to the new one.
    await expect(neverSent).resolves.toBe('trashed n2');
    finish(undefined);
    // Closed with a sent call in hand, the refusal says it was sent.
    const sent = lib.call('trashNote', ['n3']);
    sent.catch(() => {});
    await lib.close();
    await expect(sent).rejects.toMatchObject({ name: 'LibraryMovedError', sent: true });
  });

  it('attaches to a new holder that announces itself while the old one never said it was closing', async () => {
    holder(channel.port(), { notes: [note('n1')] });
    const lib = await client();
    holder(channel.port(), { notes: [note('n1'), note('n2'), note('n3')] });
    await settle();
    await settle();
    expect(lib.notes.size).toBe(3);
  });

  it('refuses the calls in hand when closed, and is halted before a holder answered', async () => {
    holder(channel.port());
    const lib = await client();
    const inHand = lib.call('trashNote', ['n1']);
    inHand.catch(() => {});
    await lib.close();
    await expect(inHand).rejects.toBeInstanceOf(LibraryMovedError);
    await expect(lib.call('trashNote', ['n1'])).rejects.toBeInstanceOf(LibraryMovedError);
    // Halted before any holder answered: the attach is refused as an abort, not a fault.
    const halting = new AbortController();
    const attaching = attach(hooks(), halting);
    attaching.catch(() => {});
    halting.abort();
    await expect(attaching).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('hears only what is for it on its own channel, and the account’s on the shared one', async () => {
    holder(channel.port(), { notes: [note('n1')] });
    const bystander: Message['type'][] = [];
    channel.port().listen((m) => bystander.push(m.type));
    const lib = await client();
    const answer = lib.call('trashNote', ['n1']);
    await settle();
    await expect(answer).resolves.toBe('trashed n1');
    expect(bystander).toContain('hello');
    expect(bystander).not.toContain('rows');
    expect(bystander).not.toContain('attached');
    expect(bystander).not.toContain('answer');
  });

  it('is forwarded nothing by a holder with no client, and nothing more after it says bye', async () => {
    const h = holder(channel.port(), { notes: [note('n1')] });
    const changes = () => channel.posted.filter((m) => m.type === 'changes').length;
    h.notes.upsert({ ...note('n1'), title: 'alone', updatedAt: 2 });
    h.moveSync({ pending: 1 });
    await settle();
    expect(changes()).toBe(0);
    expect(channel.posted.filter((m) => m.type === 'status')).toHaveLength(0);
    const lib = await client();
    h.notes.upsert({ ...note('n1'), title: 'heard', updatedAt: 3 });
    await settle();
    expect(changes()).toBe(1);
    expect(lib.notes.get('n1')?.title).toBe('heard');
    await lib.close();
    await settle();
    expect(channel.posted.filter((m) => m.type === 'bye')).toHaveLength(1);
    h.notes.upsert({ ...note('n1'), title: 'unheard', updatedAt: 4 });
    await settle();
    expect(changes()).toBe(1);
  });

  it('ignores rows and answers meant for another client', async () => {
    holder(channel.port(), { notes: [note('n1')] });
    const a = await client();
    const b = await client();
    expect(a.notes.size).toBe(1);
    expect(b.notes.size).toBe(1);
    const fromA = a.call('trashNote', ['n1']);
    await settle();
    await expect(fromA).resolves.toBe('trashed n1');
    const answers = channel.posted.filter((m): m is Extract<Message, { type: 'answer' }> => m.type === 'answer');
    expect(answers).toHaveLength(1);
  });
});

describe('carry and revive', () => {
  it('keeps the class and what it carries across the channel', () => {
    const changed = revive(carry(new NoteChangedError({ id: 'n1' } as never)));
    expect(changed).toBeInstanceOf(NoteChangedError);
    expect((changed as NoteChangedError).current).toEqual({ id: 'n1' });
    expect(revive(carry(new OfflineError()))).toBeInstanceOf(OfflineError);
    const api = revive(carry(new ApiError(404, 'Not found')));
    expect(api).toBeInstanceOf(ApiError);
    expect(api).toMatchObject({ status: 404, message: 'Not found' });
    const plain = revive(carry(new RangeError('too big')));
    expect(plain).toMatchObject({ name: 'RangeError', message: 'too big' });
    expect(revive(carry('oops'))).toMatchObject({ message: 'oops' });
  });
});
