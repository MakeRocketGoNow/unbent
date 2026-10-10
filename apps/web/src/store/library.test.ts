import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_TIMEOUT_MS, FeedTimeoutError, LIBRARY_OPEN_TIMEOUT_MS, LIBRARY_ROOTS, LibraryOpenTimeoutError, acquireLibrary, closeLibraryAndStore, currentLibrary, fetchJson, resetLibraryForTests, rootsOfNoteChanges } from './library.js';
import { openLocalStore } from './db.js';
import { reportError } from '../report-error.js';

vi.mock('./db.js', () => ({ openLocalStore: vi.fn(), closeLocalStore: vi.fn(async () => {}), openSearchDatabase: vi.fn() }));
import { closeLocalStore } from './db.js';
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
 * Opening the library is bounded for its caller. It waits on things outside the tab —
 * the outbox's database, the collections' leader — and an open that never settled left
 * every screen on "Opening your notes…" with nothing reported. Past the bound the page
 * reads the server and the error is reported; the open itself goes on in the queue, the
 * account keeps its refusal so no navigation waits again, and a close or a later open
 * waits behind it.
 */
describe('acquireLibrary', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetLibraryForTests();
    vi.mocked(openLocalStore).mockReset();
    vi.mocked(reportError).mockReset();
  });

  it('refuses its caller when an open does not settle, reports it, and answers every later ask at once', async () => {
    vi.useFakeTimers();
    vi.mocked(openLocalStore).mockImplementation(() => new Promise(() => {}));
    const first = acquireLibrary('u1');
    const settled = expect(first).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    await settled;
    expect(reportError).toHaveBeenCalledWith(expect.any(LibraryOpenTimeoutError), 'error');
    // The queries read the server: what they are given is the refusal.
    await expect(currentLibrary()).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    // The root `beforeLoad` asks again on every navigation: the same refusal, now, not
    // another wait and another report.
    const again = acquireLibrary('u1');
    expect(again).toBe(first);
    await expect(again).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    expect(openLocalStore).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('lets a close and a later open wait behind the open it refused, and opens anew once that has settled', async () => {
    vi.useFakeTimers();
    let fail!: (err: Error) => void;
    vi.mocked(openLocalStore).mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const first = acquireLibrary('u1');
    first.catch(() => {});
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    // A sign-out: its close is queued behind the open still in hand.
    let closed = false;
    void closeLibraryAndStore().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(closeLocalStore).not.toHaveBeenCalled();
    // The open ends: the close runs, and a sign-in after it opens anew.
    fail(new Error('store gone'));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
    vi.mocked(openLocalStore).mockRejectedValueOnce(new Error('no OPFS'));
    await expect(acquireLibrary('u1')).rejects.toThrow('no OPFS');
    expect(openLocalStore).toHaveBeenCalledTimes(2);
  });

  it('closes the account before a switch inside the queue, so a wipe meanwhile waits for it too', async () => {
    vi.useFakeTimers();
    // An account whose open never settles, then a switch to another: the switch's open is
    // behind the first's step, and refuses its caller on its own clock.
    vi.mocked(openLocalStore).mockImplementation(() => new Promise(() => {}));
    const first = acquireLibrary('u1');
    first.catch(() => {});
    const second = acquireLibrary('u2');
    const secondSettled = expect(second).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    await secondSettled;
    expect(openLocalStore).toHaveBeenCalledTimes(1);
    // A wipe queued behind both does not reach the store while they are in hand.
    let wiped = false;
    void closeLibraryAndStore().then(() => (wiped = true));
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    expect(wiped).toBe(false);
    expect(closeLocalStore).not.toHaveBeenCalled();
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
