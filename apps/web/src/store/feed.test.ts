import { describe, expect, it } from 'vitest';
import type { FeedAttachment, FeedNote, FeedNotebook, FeedPage, FeedReset, FeedTag, SnapshotPage } from '@unbent/shared';
import { FeedEngine, isWhole, type Controls, type Position } from './feed.js';

/**
 * The feed's reader against a fake server and fake collections: what a page does to the
 * four collections, where the cursor goes and when, and what a `reset` undoes.
 */

interface Fake<T extends object> extends Controls<T> {
  rows: Map<string, T>;
  log: string[];
  ready: number;
}

/**
 * `seq` is a log shared with the harness's cursor store, so a test can say what order the
 * collections' commits settled and the cursor was written in: the engine's promise is that
 * no cursor reaches disk before the rows it stands for, and the fakes have to be able to
 * tell `await c.commit()` from `c.commit()` for that to be checkable. So `commit` settles
 * on a later microtask, as the persistence layer's does, and logs to `seq` only then.
 */
function fake<T extends object>(name: string, keyOf: (row: T) => string, seq: string[] = []): Fake<T> {
  const rows = new Map<string, T>();
  const log: string[] = [];
  let open = false;
  const f: Fake<T> = {
    rows,
    log,
    ready: 0,
    begin: () => {
      if (open) throw new Error('begin inside a transaction');
      open = true;
      log.push('begin');
    },
    write: (m) => {
      if (!open) throw new Error('write outside a transaction');
      if (m.type === 'delete') {
        rows.delete(m.key);
        log.push(`delete ${m.key}`);
      } else {
        const key = keyOf(m.value);
        if (m.type === 'insert' && rows.has(key)) throw new Error(`insert of a held key ${key}`);
        if (m.type === 'update' && !rows.has(key)) throw new Error(`update of a missing key ${key}`);
        rows.set(key, m.value);
        log.push(`${m.type} ${key}`);
      }
    },
    commit: () => {
      open = false;
      log.push('commit');
      return Promise.resolve().then(() => seq.push(`${name} committed`));
    },
    truncate: () => {
      // As TanStack DB's persistence wrapper does (NoPendingSyncTransactionWriteError): a
      // fake that allowed this hid a reset that failed on every pull.
      if (!open) throw new Error('truncate outside a transaction');
      rows.clear();
      log.push('truncate');
    },
    markReady: () => {
      f.ready += 1;
    },
    has: (key) => rows.has(key),
    values: () => rows.values(),
  };
  return f;
}

const note = (id: string, over: Partial<FeedNote> = {}): FeedNote => ({
  id,
  title: `Note ${id}`,
  body: 'b',
  createdAt: 1,
  updatedAt: 1,
  tagIds: [],
  notebookId: null,
  files: [],
  ...over,
});
const file = (id: string, noteId: string): FeedAttachment => ({ id, noteId, filename: `${id}.pdf`, contentType: 'application/pdf', size: 1, hasText: false, createdAt: 1 });

function harness(answers: Record<string, unknown[] | unknown>) {
  const requests: string[] = [];
  let cursor: Position | null = null;
  const cursorWrites: Array<Position | null> = [];
  const seq: string[] = [];
  const c = { note: fake<FeedNote>('note', (n) => n.id, seq), notebook: fake<FeedNotebook>('notebook', (n) => n.id, seq), tag: fake<FeedTag>('tag', (t) => t.id, seq), attachment: fake<FeedAttachment>('attachment', (a) => a.id, seq) };
  const engine = new FeedEngine({
    onTruncated: () => seq.push('truncated'),
    fetchJson: async <T,>(path: string): Promise<T> => {
      requests.push(path);
      const a = answers[path];
      if (a === undefined) throw new Error(`no answer for ${path}`);
      if (Array.isArray(a)) {
        const next = a.shift();
        if (next === undefined) throw new Error(`answers for ${path} ran out`);
        if (next instanceof Error) throw next;
        return next as T;
      }
      return a as T;
    },
    readCursor: async () => cursor,
    writeCursor: async (c) => {
      cursor = c;
      cursorWrites.push(c);
      seq.push(`cursor ${c ? c.seq : 'null'}`);
    },
    pageSize: 2,
  });
  return { engine, c, requests, cursorWrites, seq, cursor: () => cursor, setCursor: (p: Position | null) => void (cursor = p) };
}

const snapshotFirst = (notes: FeedNote[], next: string | null, seq = 10): SnapshotPage => ({ seq, epoch: 'e1', notes, next, notebooks: [{ id: 'nb1', name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] }], tags: [{ id: 't1', name: 'home' }], total: 3 });
const feedPage = (over: Partial<FeedPage>): FeedPage => ({ reset: false, seq: 10, epoch: 'e1', next: 10, more: false, notes: [], notebooks: [], tags: [], attachments: [], tombstones: [], ...over });

describe('FeedEngine', () => {
  it('walks the snapshot when there is no cursor, storing the first page\'s seq before it applies anything', async () => {
    const h = harness({
      '/api/changes/snapshot?limit=2': snapshotFirst([note('a', { files: [file('f1', 'a')] }), note('b')], 'b'),
      '/api/changes/snapshot?limit=2&cursor=b': { seq: 12, epoch: 'e1', notes: [note('c')], next: null } satisfies SnapshotPage,
    });
    const stop = { note: h.engine.register('note', h.c.note), notebook: h.engine.register('notebook', h.c.notebook), tag: h.engine.register('tag', h.c.tag), attachment: h.engine.register('attachment', h.c.attachment) };
    // Registering the fourth collection starts the first pull itself.
    await h.engine.settled();
    expect([...h.c.note.rows.keys()]).toEqual(['a', 'b', 'c']);
    expect([...h.c.notebook.rows.keys()]).toEqual(['nb1']);
    expect([...h.c.tag.rows.keys()]).toEqual(['t1']);
    expect([...h.c.attachment.rows.keys()]).toEqual(['f1']);
    // The position after the first page, then the cursor once the walk is whole: the
    // first page's seq, not the last's, so what was written during the walk is replayed
    // by the feed.
    expect(h.cursorWrites).toEqual([{ seq: 10, epoch: 'e1', resume: 'b', total: 3 }, { seq: 10, epoch: 'e1' }]);
    // And each only once the page's commits have settled: the first page wrote all four
    // collections, the second only notes, and no position was written ahead of either.
    expect(h.seq).toEqual(['note committed', 'notebook committed', 'tag committed', 'attachment committed', 'cursor 10', 'note committed', 'cursor 10']);
    expect(h.engine.state).toMatchObject({ phase: 'current', total: 3, applied: 3, lastError: null, pulls: 1 });
    expect(h.c.note.ready).toBe(1);
    Object.values(stop).forEach((s) => s());
  });

  it('resumes a walk that was cut short where it stopped, and never applies a page over a stale cursor', async () => {
    const h = harness({
      '/api/changes/snapshot?limit=2': snapshotFirst([note('a'), note('b')], 'b'),
      '/api/changes/snapshot?limit=2&cursor=b': [new Error('the tab closed'), { seq: 12, epoch: 'e1', notes: [note('c')], next: null } satisfies SnapshotPage],
    });
    const stop = Object.entries(h.c).map(([k, c]) => h.engine.register(k as 'note', c as never));
    await h.engine.settled();
    expect(h.engine.state).toMatchObject({ phase: 'failed', cursor: null, applied: 2, total: 3 });
    expect(h.cursor()).toEqual({ seq: 10, epoch: 'e1', resume: 'b', total: 3 });

    await h.engine.pull();
    expect(h.requests).toEqual(['/api/changes/snapshot?limit=2', '/api/changes/snapshot?limit=2&cursor=b', '/api/changes/snapshot?limit=2&cursor=b']);
    expect([...h.c.note.rows.keys()]).toEqual(['a', 'b', 'c']);
    expect(h.engine.state).toMatchObject({ phase: 'current', cursor: { seq: 10, epoch: 'e1' }, applied: 3, total: 3 });
    expect(h.cursor()).toEqual({ seq: 10, epoch: 'e1' });
    stop.forEach((s) => s());
  });

  it('drops a stored position the server refuses for good and walks again from nothing', async () => {
    const refused = Object.assign(new Error('Bad cursor'), { status: 400 });
    const h = harness({
      '/api/changes/snapshot?limit=2&cursor=stale': [refused],
      '/api/changes/snapshot?limit=2': snapshotFirst([note('a'), note('b')], null, 20),
    });
    // What the first attempt applied: a note purged since, which the new walk will not
    // bring and the feed from the new seq will never delete.
    h.c.note.rows.set('a', note('a'));
    h.c.note.rows.set('gone', note('gone', { files: [file('f1', 'gone')] }));
    h.c.attachment.rows.set('f1', file('f1', 'gone'));
    h.setCursor({ seq: 10, epoch: 'e1', resume: 'stale', total: 3 });
    const stop = Object.entries(h.c).map(([k, c]) => h.engine.register(k as 'note', c as never));
    await h.engine.settled();
    expect(h.requests).toEqual(['/api/changes/snapshot?limit=2&cursor=stale', '/api/changes/snapshot?limit=2']);
    expect([...h.c.note.rows.keys()]).toEqual(['a', 'b']);
    expect([...h.c.attachment.rows.keys()]).toEqual([]);
    expect(h.cursorWrites).toEqual([null, { seq: 20, epoch: 'e1' }]);
    expect(h.engine.state).toMatchObject({ phase: 'current', cursor: { seq: 20, epoch: 'e1' } });
    stop.forEach((s) => s());
  });

  it('keeps a stored position the server could not answer for now', async () => {
    const h = harness({
      '/api/changes/snapshot?limit=2&cursor=b': [new Error("You're offline."), { seq: 12, epoch: 'e1', notes: [note('c')], next: null } satisfies SnapshotPage],
    });
    h.setCursor({ seq: 10, epoch: 'e1', resume: 'b', total: 3 });
    const stop = Object.entries(h.c).map(([k, c]) => h.engine.register(k as 'note', c as never));
    await h.engine.settled();
    expect(h.engine.state.phase).toBe('failed');
    expect(h.cursor()).toEqual({ seq: 10, epoch: 'e1', resume: 'b', total: 3 });
    await h.engine.pull();
    expect(h.engine.state).toMatchObject({ phase: 'current', cursor: { seq: 10, epoch: 'e1' } });
    stop.forEach((s) => s());
  });

  it('keeps a stored position through a lapsed session, a timeout and a rate limit', async () => {
    // The same three 4xx the outbox retries: a dead cursor they are not, and emptying
    // the copy on them used to throw away a first walk's progress (and its resume).
    for (const status of [401, 408, 429]) {
      const later = Object.assign(new Error(`${status}`), { status });
      const h = harness({
        '/api/changes/snapshot?limit=2&cursor=b': [later, { seq: 12, epoch: 'e1', notes: [note('c')], next: null } satisfies SnapshotPage],
      });
      h.c.note.rows.set('a', note('a'));
      h.c.note.rows.set('b', note('b'));
      h.setCursor({ seq: 10, epoch: 'e1', resume: 'b', total: 3 });
      const stop = Object.entries(h.c).map(([k, c]) => h.engine.register(k as 'note', c as never));
      await h.engine.settled();
      expect(h.engine.state.phase, `${status} should not end the walk`).toBe('failed');
      expect(h.cursor()).toEqual({ seq: 10, epoch: 'e1', resume: 'b', total: 3 });
      expect([...h.c.note.rows.keys()]).toEqual(['a', 'b']);
      expect(h.c.note.log).not.toContain('truncate');
      await h.engine.pull();
      expect(h.engine.state).toMatchObject({ phase: 'current', cursor: { seq: 10, epoch: 'e1' } });
      expect([...h.c.note.rows.keys()]).toEqual(['a', 'b', 'c']);
      stop.forEach((s) => s());
    }
  });

  it('on a fresh start, picks a stored position up and reads only the pages left', async () => {
    const h = harness({
      '/api/changes/snapshot?limit=2&cursor=b': { seq: 12, epoch: 'e1', notes: [note('c')], next: null } satisfies SnapshotPage,
    });
    h.c.note.rows.set('a', note('a'));
    h.c.note.rows.set('b', note('b'));
    h.setCursor({ seq: 10, epoch: 'e1', resume: 'b', total: 3 });
    const stop = Object.entries(h.c).map(([k, c]) => h.engine.register(k as 'note', c as never));
    await h.engine.settled();
    expect(h.requests).toEqual(['/api/changes/snapshot?limit=2&cursor=b']);
    expect(h.engine.state).toMatchObject({ phase: 'current', cursor: { seq: 10, epoch: 'e1' }, applied: 3, total: 3 });
    stop.forEach((s) => s());
  });

  it('follows the feed from the cursor, page after page while more, and moves the cursor after each', async () => {
    const h = harness({
      '/api/changes?since=10&epoch=e1&limit=2': feedPage({ next: 12, more: true, notes: [note('a', { title: 'A2' }), note('d')] }),
      '/api/changes?since=12&epoch=e1&limit=2': feedPage({ next: 13, more: false, tombstones: [{ entity: 'note', id: 'd' }], tags: [{ id: 't2', name: 'new' }] }),
    });
    await h.engine['options'].writeCursor({ seq: 10, epoch: 'e1' });
    h.c.note.rows.set('a', note('a'));
    for (const k of ['note', 'notebook', 'tag', 'attachment'] as const) h.engine.register(k, h.c[k] as never);
    await h.engine.settled();
    expect(h.requests).toEqual(['/api/changes?since=10&epoch=e1&limit=2', '/api/changes?since=12&epoch=e1&limit=2']);
    expect(h.c.note.log).toEqual(['begin', 'update a', 'insert d', 'commit', 'begin', 'delete d', 'commit']);
    expect(h.c.note.rows.get('a')?.title).toBe('A2');
    expect(h.cursorWrites.slice(1)).toEqual([{ seq: 12, epoch: 'e1' }, { seq: 13, epoch: 'e1' }]);
  });

  it('on reset, empties every collection and walks the snapshot again', async () => {
    const h = harness({
      '/api/changes?since=10&epoch=old&limit=2': { reset: true, seq: 50, epoch: 'e2' } satisfies FeedReset,
      '/api/changes/snapshot?limit=2': snapshotFirst([note('z')], null, 50),
    });
    await h.engine['options'].writeCursor({ seq: 10, epoch: 'old' });
    h.c.note.rows.set('stale', note('stale'));
    for (const k of ['note', 'notebook', 'tag', 'attachment'] as const) h.engine.register(k, h.c[k] as never);
    await h.engine.settled();
    for (const k of ['note', 'notebook', 'tag', 'attachment'] as const) expect(h.c[k].log.slice(0, 3)).toEqual(['begin', 'truncate', 'commit']);
    expect([...h.c.note.rows.keys()]).toEqual(['z']);
    expect(h.cursor()).toEqual({ seq: 50, epoch: 'e1' });
    // Counted, for a view holding a copy of a row the reset may have made newer than the truth (MAK-196).
    expect(h.engine.state.resets).toBe(1);
    // The cursor is cleared only once every collection's truncate has settled on disk: a
    // cursor gone before the rows would make the next open walk the snapshot over them.
    // The library is told the rows are gone only once every truncate has committed, and
    // before the cursor goes: what the query bridge drops its cached answers on.
    const truncated = h.seq.indexOf('truncated');
    expect(h.seq.slice(0, truncated).filter((e) => e.endsWith('committed'))).toHaveLength(4);
    expect(truncated).toBeLessThan(h.seq.indexOf('cursor null'));
    const cleared = h.seq.indexOf('cursor null');
    expect(cleared).toBeGreaterThan(-1);
    expect(h.seq.slice(0, cleared).filter((e) => e.endsWith('committed'))).toHaveLength(4);
  });

  it('a note row replaces the note\'s files, and a note tombstone takes them', async () => {
    const h = harness({
      '/api/changes?since=10&epoch=e1&limit=2': feedPage({
        next: 11,
        notes: [note('a', { files: [file('f2', 'a')] })],
        tombstones: [{ entity: 'note', id: 'b' }, { entity: 'attachment', id: 'f9' }],
        attachments: [file('f3', 'c')],
      }),
    });
    await h.engine['options'].writeCursor({ seq: 10, epoch: 'e1' });
    h.c.note.rows.set('a', note('a'));
    h.c.note.rows.set('b', note('b'));
    h.c.attachment.rows.set('f1', file('f1', 'a'));
    h.c.attachment.rows.set('f8', file('f8', 'b'));
    h.c.attachment.rows.set('f9', file('f9', 'c'));
    for (const k of ['note', 'notebook', 'tag', 'attachment'] as const) h.engine.register(k, h.c[k] as never);
    await h.engine.settled();
    expect([...h.c.attachment.rows.keys()].sort()).toEqual(['f2', 'f3']);
    expect([...h.c.note.rows.keys()]).toEqual(['a']);
  });

  it('a failed pull leaves the collections ready, keeps the cursor, and reports the error', async () => {
    const h = harness({ '/api/changes?since=10&epoch=e1&limit=2': [new Error("You're offline.")] });
    await h.engine['options'].writeCursor({ seq: 10, epoch: 'e1' });
    for (const k of ['note', 'notebook', 'tag', 'attachment'] as const) h.engine.register(k, h.c[k] as never);
    await h.engine.settled();
    expect(h.engine.state).toMatchObject({ phase: 'failed', lastError: "You're offline.", cursor: { seq: 10, epoch: 'e1' } });
    expect(h.c.note.ready).toBe(1);
    expect(h.c.attachment.ready).toBe(1);
  });

  it('coalesces pulls: one runs at a time, a request during a run queues exactly one more', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      '/api/changes?since=10&epoch=e1&limit=2': [
        gate.then(() => feedPage({ next: 11 })),
        feedPage({ next: 11, seq: 11 }),
      ].map((p) => p),
    });
    // The first answer is a promise the fake resolves; make fetchJson await it.
    const original = h.engine['options'].fetchJson;
    h.engine['options'].fetchJson = async <T,>(path: string) => (await original<T | Promise<T>>(path)) as T;
    await h.engine['options'].writeCursor({ seq: 10, epoch: 'e1' });
    for (const k of ['note', 'notebook', 'tag', 'attachment'] as const) h.engine.register(k, h.c[k] as never);
    const first = h.engine.settled();
    const second = h.engine.pull();
    const third = h.engine.pull();
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    await first;
    // Two requests: the one in flight, and the one the queued pulls collapsed into.
    expect(h.requests.filter((r) => r.startsWith('/api/changes?')).length).toBe(2);
    expect(h.engine.state.pulls).toBe(1);
  });
});

describe('isWhole', () => {
  const cursor = { seq: 3, epoch: 'e' };

  it('is whole once a walk has finished, whether or not the last pull did', () => {
    expect(isWhole({ cursor, phase: 'current' })).toBe(true);
    expect(isWhole({ cursor, phase: 'failed' })).toBe(true);
    expect(isWhole({ cursor, phase: 'starting' })).toBe(true);
  });

  it('is not whole before the first walk, during one, or after a reset', () => {
    expect(isWhole({ cursor: null, phase: 'starting' })).toBe(false);
    expect(isWhole({ cursor: null, phase: 'failed' })).toBe(false);
    expect(isWhole({ cursor, phase: 'hydrating' })).toBe(false);
    expect(isWhole({ cursor, phase: 'reset' })).toBe(false);
  });
});
