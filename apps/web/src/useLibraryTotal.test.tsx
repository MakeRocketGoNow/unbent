import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { FeedNote } from '@unbent/shared';
import * as api from './notes-api.js';
import { libraryTotalQuery } from './queries.js';
import { installTestLibrary, type TestLibrary } from './store/test-library.js';
import { showsWholeAccount, useLibraryTotal } from './useLibraryTotal.js';

vi.mock('./notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./notes-api.js')>()),
  listNotes: vi.fn(),
}));

const note = (id: string, over: Partial<FeedNote> = {}): FeedNote => ({
  id,
  title: id,
  body: '',
  createdAt: 1,
  updatedAt: 1,
  tagIds: [],
  notebookId: null,
  files: [],
  ...over,
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('libraryTotalQuery', () => {
  let lib: TestLibrary | null = null;
  afterEach(() => {
    lib?.uninstall();
    lib = null;
    vi.clearAllMocks();
  });

  it('counts the live notes of a whole library, not the trash', async () => {
    lib = installTestLibrary({ notes: [note('a'), note('b', { deletedAt: 5 })] });
    await expect(client().fetchQuery(libraryTotalQuery(null))).resolves.toBe(1);
  });

  it('says an empty library is empty', async () => {
    lib = installTestLibrary({ notes: [] });
    await expect(client().fetchQuery(libraryTotalQuery(null))).resolves.toBe(0);
  });

  /** The first copy has not been taken: an empty collection is not an empty account. */
  it('does not answer for a library that has never taken a snapshot', async () => {
    lib = installTestLibrary({ notes: [], cursor: null });
    await expect(client().fetchQuery(libraryTotalQuery(null))).resolves.toBeNull();
    expect(api.listNotes).not.toHaveBeenCalled();
  });

  /** No file system to keep a library in: the server's count, which is always whole. */
  it('asks the server on a device with no library', async () => {
    vi.mocked(api.listNotes).mockResolvedValue({ items: [], cursor: null, total: 0 });
    await expect(client().fetchQuery(libraryTotalQuery(null))).resolves.toBe(0);
    expect(api.listNotes).toHaveBeenCalledWith({ limit: 1 });
  });
});

describe('useLibraryTotal', () => {
  let lib: TestLibrary | null = null;
  afterEach(() => {
    lib?.uninstall();
    lib = null;
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client()}>{children}</QueryClientProvider>
  );

  it('is null until the count is in, then the count', async () => {
    lib = installTestLibrary({ notes: [note('only')] });
    const { result } = renderHook(() => useLibraryTotal(), { wrapper });
    // Unknown first, never zero: zero is what draws the empty state.
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(1));
  });

  /** Off, it asks nothing — no count from the library, no request — and answers null. */
  it('asks nothing while the caller says the answer cannot matter', async () => {
    vi.mocked(api.listNotes).mockResolvedValue({ items: [], cursor: null, total: 0 });
    const { result } = renderHook(() => useLibraryTotal(false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
    expect(api.listNotes).not.toHaveBeenCalled();
  });

  /** A count from the last time it mattered is not read when it matters again. */
  it('counts afresh when it is switched back on', async () => {
    lib = installTestLibrary({ notes: [] });
    const { result, rerender } = renderHook(({ on }) => useLibraryTotal(on), { wrapper, initialProps: { on: true } });
    await waitFor(() => expect(result.current).toBe(0));
    rerender({ on: false });
    expect(result.current).toBeNull();
    // `gcTime: 0` drops the unwatched entry on the next turn of the event loop; in the app
    // the list has to grow and shrink again between off and on, which is many turns.
    await new Promise((r) => setTimeout(r, 0));
    lib.upsert('note', note('arrived'));
    rerender({ on: true });
    // Never the old zero, not even for the render before the count lands.
    expect(result.current).not.toBe(0);
    await waitFor(() => expect(result.current).toBe(1));
  });

  it('stays null for a library still arriving', async () => {
    lib = installTestLibrary({ notes: [], cursor: null });
    const { result } = renderHook(() => useLibraryTotal(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });
});

describe('showsWholeAccount', () => {
  it('is All notes with nothing applied, whatever the order', () => {
    expect(showsWholeAccount({})).toBe(true);
    expect(showsWholeAccount({ q: '  ' })).toBe(true);
    expect(showsWholeAccount({ tag: [], field: [] })).toBe(true);
  });

  it('is not a notebook, the inbox, a tag, a field, a date range or a search', () => {
    expect(showsWholeAccount({ notebook: 'Coupons' })).toBe(false);
    expect(showsWholeAccount({ notebook: '[unfiled]' })).toBe(false);
    expect(showsWholeAccount({ tag: ['red'] })).toBe(false);
    expect(showsWholeAccount({ field: ['f:set'] })).toBe(false);
    expect(showsWholeAccount({ from: '2026-01-01' })).toBe(false);
    expect(showsWholeAccount({ to: '2026-01-01' })).toBe(false);
    expect(showsWholeAccount({ q: 'receipt' })).toBe(false);
  });
});
