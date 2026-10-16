import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { Note } from '@unbent/shared';
import { installTestLibrary } from '../store/test-library.js';
import type { Outbox, SyncStatus } from '../store/actions.js';
import { installLibraryQueries, keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../store/use-outbox.js', () => ({
  useOutbox: vi.fn(),
  useSyncStatus: vi.fn(),
}));
import { useOutbox, useSyncStatus } from '../store/use-outbox.js';

/**
 * An operator winds the account back while a note is open (MAK-196). The feed resets
 * and the row comes back older than the copy the workspace last saved; the workspace's
 * rule of taking only a newer copy (right for the stale row a replayed save leaves for
 * a moment) kept the edit on screen that the wind-back had removed, while the list
 * beside it had already dropped it.
 */
const before: Note = { id: 'n1', title: 'Acme — sample card', body: 'Owner.', tags: [], notebook: null, createdAt: 0, updatedAt: 100, fields: [] };
const edited: Note = { ...before, title: 'Acme — sample card 👾', body: 'Owner.\n\nA line typed today.', updatedAt: 200 };

function outbox(): Outbox {
  const status = (): SyncStatus => ({ pending: 0, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() });
  return {
    status,
    subscribe: (l: (s: SyncStatus) => void) => {
      l(status());
      return () => {};
    },
    onAcknowledged: () => () => {},
    resolveConflict: vi.fn(),
    dispose: async () => {},
    executor: {},
  } as unknown as Outbox;
}

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  client.setQueryData(keys.attachments(before.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [], autofill: false });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 1 });
  const rootRoute = createRootRoute({ component: () => <Workspace noteId={before.id} /> });
  const notesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes' });
  const router = createRouter({ routeTree: rootRoute.addChildren([notesRoute]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return client;
}

const row = (n: Note) => {
  const { tags: _t, notebook: _n, ...rest } = n;
  return { ...rest, tagIds: [], files: [] };
};
const title = () => screen.findByPlaceholderText<HTMLInputElement>('Untitled');

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.mocked(useOutbox).mockReturnValue(outbox());
  vi.mocked(useSyncStatus).mockReturnValue({ pending: 0, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the open note after a wind-back', () => {
  it('ignores an older copy while nothing has reset: the stale row of a replayed save', async () => {
    const lib = installTestLibrary({ notes: [row(edited)] });
    const client = mount();
    await waitFor(async () => expect((await title()).value).toBe(edited.title));
    await act(async () => {
      lib.upsert('note', row(before));
      await client.invalidateQueries({ queryKey: keys.note(before.id) });
    });
    await waitFor(async () => expect((await title()).value).toBe(edited.title));
    lib.uninstall();
  });

  it('opens the restored copy after a wind-back, not the answer cached from before it', async () => {
    // The app's cache keeps an answer fresh for thirty seconds; a note opened, closed and
    // opened again inside that window was served its pre-wind-back answer by the route
    // loader, and the workspace seeded from it and refused the older truth (MAK-196,
    // second half). The bridge drops unwatched library answers on a reset instead.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const stop = installLibraryQueries(client);
    const lib = installTestLibrary({ notes: [row(edited)] });
    try {
      mount(client);
      await waitFor(async () => expect((await title()).value).toBe(edited.title));
      cleanup();

      // The wind-back while the note is closed: the library starts over and the row comes back older.
      await act(async () => {
        lib.reset();
        lib.upsert('note', row({ ...before, updatedAt: 99 }));
      });
      mount(client);
      await waitFor(async () => expect((await title()).value).toBe(before.title));
    } finally {
      // A failed assertion must not leave the bridge's listener installed for later tests.
      stop();
      lib.uninstall();
    }
  });

  it('shows the restored copy once the library has reset, although it is older than what was last saved', async () => {
    const lib = installTestLibrary({ notes: [row(edited)] });
    const client = mount();
    await waitFor(async () => expect((await title()).value).toBe(edited.title));

    // The reset is heard first, while the query still holds the copy on screen; that copy
    // must not spend the reset (found in review).
    await act(async () => {
      lib.reset();
      await client.invalidateQueries({ queryKey: keys.note(before.id) });
    });
    await waitFor(async () => expect((await title()).value).toBe(edited.title));

    // Then the walk brings the wound-back row, older than the base.
    await act(async () => {
      lib.upsert('note', row({ ...before, updatedAt: 99 }));
      await client.invalidateQueries({ queryKey: keys.note(before.id) });
    });
    await waitFor(async () => expect((await title()).value).toBe(before.title));
    await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).not.toContain('A line typed today'));

    // Whole again, and the rule is forward-only once more: an older copy is refused.
    await act(async () => {
      lib.settle();
      lib.upsert('note', row({ ...before, title: 'older still', updatedAt: 50 }));
      await client.invalidateQueries({ queryKey: keys.note(before.id) });
    });
    await waitFor(async () => expect((await title()).value).toBe(before.title));
    lib.uninstall();
  });
});
