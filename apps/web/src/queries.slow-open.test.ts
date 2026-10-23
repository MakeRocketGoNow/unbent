import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A read does not wait for a slow open while there is a connection. The case: a reload
 * beside a tab the browser has frozen, whose worker keeps the store's file locked, so
 * the open waits out its whole bound; the note route's loader waited with it, on a
 * white page.
 */
const state = vi.hoisted(() => ({
  open: null as Promise<unknown> | null,
  offline: false,
}));

vi.mock('./store/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store/library.js')>()),
  currentLibrary: () => state.open,
}));
vi.mock('./connectivity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connectivity.js')>()),
  offlineNow: () => state.offline,
}));
vi.mock('./notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./notes-api.js')>()),
  getNote: vi.fn(async (id: string) => ({ id, title: 'from the server' })),
  searchNotes: vi.fn(async () => {
    throw new (await import('./notes-api.js')).OfflineError();
  }),
}));

const { installLibraryQueries, keys, noteQuery, search } = await import('./queries.js');
const api = await import('./notes-api.js');

describe('a read while the library is still opening', () => {
  const client = new QueryClient();
  let stop = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
    stop = installLibraryQueries(client);
    vi.mocked(api.getNote).mockClear();
  });
  afterEach(() => {
    stop();
    client.clear();
    vi.useRealTimers();
    state.offline = false;
  });

  it('asks the server after a short wait, and is asked again once the open lands', async () => {
    let land!: (lib: unknown) => void;
    state.open = new Promise((resolve) => (land = resolve));

    const read = client.fetchQuery(noteQuery('n1'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.getNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toEqual({ id: 'n1', title: 'from the server' });

    land({});
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryState(keys.note('n1'))?.isInvalidated).toBe(true);
  });

  it('waits for the open in a search the server could not answer', async () => {
    // The connectivity state has not caught up with the failed request yet, and the
    // device's index is the only answer there is.
    state.open = new Promise(() => {});
    let settled = false;
    void search('crumb')
      .catch(() => {})
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.searchNotes).toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it('waits for the open while offline, since the server is no answer then', async () => {
    state.offline = true;
    state.open = new Promise(() => {});
    let settled = false;
    // Left hanging for `client.clear` to cancel, which it does with a rejection.
    void client
      .fetchQuery(noteQuery('n2'))
      .catch(() => {})
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    expect(api.getNote).not.toHaveBeenCalled();
  });
});
