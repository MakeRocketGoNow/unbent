import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_TIMEOUT_MS, FeedTimeoutError, LIBRARY_OPEN_TIMEOUT_MS, LIBRARY_ROOTS, LibraryOpenTimeoutError, acquireLibrary, currentLibrary, fetchJson, resetLibraryForTests, rootsOfNoteChanges } from './library.js';
import { openLocalStore } from './db.js';
import { reportError } from '../report-error.js';

vi.mock('./db.js', () => ({ openLocalStore: vi.fn(), closeLocalStore: vi.fn(async () => {}), openSearchDatabase: vi.fn() }));
vi.mock('../report-error.js', () => ({ reportError: vi.fn() }));

/**
 * Which queries a change to the notes collection reaches. A save that changed only the
 * text re-runs the list and the note; anything that moves a note between lists or counts
 * — filing, tagging, trashing, a field, a row arriving or going — re-runs everything.
 */
const row = { id: 'n1', title: 'a', body: 'b', updatedAt: 1, deletedAt: undefined, notebookId: 'nb', tagIds: ['t1', 't2'], fields: [{ fieldId: 'f', value: 1 }] };

describe('rootsOfNoteChanges', () => {
  it('reaches only the list and the note for a change of text', () => {
    const roots = rootsOfNoteChanges([{ type: 'update', previousValue: row, value: { ...row, title: 'b', body: 'c', updatedAt: 2 } }]);
    expect([...roots].sort()).toEqual(['note', 'notes']);
  });

  it('reaches the trash too when the note is in it', () => {
    const trashed = { ...row, deletedAt: 5 };
    const roots = rootsOfNoteChanges([{ type: 'update', previousValue: trashed, value: { ...trashed, title: 'b' } }]);
    expect([...roots].sort()).toEqual(['note', 'notes', 'trash']);
  });

  it.each([
    ['filing', { notebookId: 'other' }],
    ['a notebook named by a write made here', { notebookName: 'New' }],
    ['tagging', { tagIds: ['t1'] }],
    ['tags named by a write made here', { tagNames: ['x'] }],
    ['trashing', { deletedAt: 9 }],
    ['a field', { fields: [{ fieldId: 'f', value: 2 }] }],
  ])('reaches everything for %s', (_what, change) => {
    expect(rootsOfNoteChanges([{ type: 'update', previousValue: row, value: { ...row, ...change } }])).toBe(LIBRARY_ROOTS);
  });

  it('reaches everything for a row arriving or going, or a change it cannot read', () => {
    expect(rootsOfNoteChanges([{ type: 'insert', value: row }])).toBe(LIBRARY_ROOTS);
    expect(rootsOfNoteChanges([{ type: 'delete' }])).toBe(LIBRARY_ROOTS);
    expect(rootsOfNoteChanges([{ type: 'update', value: row }])).toBe(LIBRARY_ROOTS);
  });

  it('is the union over a batch', () => {
    const roots = rootsOfNoteChanges([
      { type: 'update', previousValue: row, value: { ...row, title: 'x' } },
      { type: 'update', previousValue: row, value: { ...row, tagIds: [] } },
    ]);
    expect(roots).toBe(LIBRARY_ROOTS);
  });
});

/**
 * The engine's fetch. A page that never arrived held the first copy for good until a
 * reload; timed out, it is a failed pull the engine can retry, and an error worth reporting.
 */
describe('fetchJson', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A fetch whose answer never comes, or whose body never finishes, until it is aborted. */
  function stalling(at: 'headers' | 'body') {
    return vi.fn((_input: string, init?: RequestInit) => {
      const aborted = new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      if (at === 'headers') return aborted;
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => aborted } as unknown as Response);
    });
  }

  it.each(['headers', 'body'] as const)('gives up on a page whose %s never arrive, naming the route and not the cursor', async (at) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stalling(at));
    const result = fetchJson('/api/changes/snapshot?limit=200&cursor=abc');
    const settled = expect(result).rejects.toBeInstanceOf(FeedTimeoutError);
    await vi.advanceTimersByTimeAsync(FEED_TIMEOUT_MS);
    await settled;
    await expect(result).rejects.toThrow('/api/changes/snapshot did not answer within 60 s');
  });

  it('gives up at once when the engine stops, as the stop and not as a timeout', async () => {
    vi.stubGlobal('fetch', stalling('headers'));
    const stop = new AbortController();
    const result = fetchJson('/api/changes?since=10&epoch=e1&limit=200', stop.signal);
    stop.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('names the route alone when the server refuses, so every page groups as one report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, headers: new Headers() }) as unknown as Response));
    await expect(fetchJson('/api/changes?since=10&epoch=e1&limit=200')).rejects.toMatchObject({ status: 503, message: '/api/changes answered 503' });
  });
});

/**
 * Opening the library is bounded. It waits on things outside the tab — the outbox's
 * database, the collections' leader — and an open that never settled left every screen
 * on "Opening your notes…" with nothing reported. Timed out, the page reads the server,
 * the error is reported, and nothing tries again until a reload.
 */
describe('acquireLibrary', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetLibraryForTests();
    vi.mocked(openLocalStore).mockReset();
    vi.mocked(reportError).mockReset();
  });

  it('gives up on an open that does not settle, reports it, and does not try again until a reload', async () => {
    vi.useFakeTimers();
    vi.mocked(openLocalStore).mockImplementation(() => new Promise(() => {}));
    const first = acquireLibrary('u1');
    const settled = expect(first).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    await settled;
    expect(reportError).toHaveBeenCalledWith(expect.any(LibraryOpenTimeoutError), 'error');
    // No library on this page load: the queries read the server.
    expect(currentLibrary()).toBeNull();
    await expect(acquireLibrary('u1')).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    expect(openLocalStore).toHaveBeenCalledTimes(1);
  });

  it('tries again once the open it gave up on has settled, without a reload', async () => {
    vi.useFakeTimers();
    let fail!: (err: Error) => void;
    vi.mocked(openLocalStore).mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const first = acquireLibrary('u1');
    const settled = expect(first).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    await settled;
    await expect(acquireLibrary('u1')).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    // The abandoned open ends: nothing of it is left, and the next sign-in may try.
    fail(new Error('store gone'));
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(openLocalStore).mockRejectedValueOnce(new Error('no OPFS'));
    await expect(acquireLibrary('u1')).rejects.toThrow('no OPFS');
    expect(openLocalStore).toHaveBeenCalledTimes(2);
  });

  it('is not a timeout that fires under an open that settled in time', async () => {
    vi.useFakeTimers();
    // A store whose open fails at once: the library is unavailable for that reason, not for time.
    vi.mocked(openLocalStore).mockRejectedValue(new Error('no OPFS'));
    await expect(acquireLibrary('u1')).rejects.toThrow('no OPFS');
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    expect(reportError).not.toHaveBeenCalled();
    expect(currentLibrary()).toBeNull();
  });
});
