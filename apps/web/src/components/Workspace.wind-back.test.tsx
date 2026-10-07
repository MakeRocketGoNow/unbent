import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { Note } from '@unbent/shared';
import { installTestLibrary } from '../store/test-library.js';
import type { Outbox, SyncStatus } from '../store/actions.js';
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../store/use-outbox.js', () => ({
  useOutbox: vi.fn(),
  useSyncStatus: vi.fn(),
}));
import { useOutbox, useSyncStatus } from '../store/use-outbox.js';

/**
 * An operator winds the account back while a note is open (MAK-196). The feed resets
 * and the row comes back older than the copy the workspace last saved; the workspace's
 * rule of taking only a newer copy — right for the stale row a replayed save leaves for
 * a moment — kept the edit on screen that the wind-back had removed, while the list
 * beside it had already dropped it.
 */
const before: Note = { id: 'n1', title: 'Casey — plumbing', body: 'Owner.', tags: [], notebook: null, createdAt: 0, updatedAt: 100, fields: [] };
const edited: Note = { ...before, title: 'Casey — plumbing 👾', body: 'Owner.\n\nA line typed today.', updatedAt: 200 };

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

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  it('shows the restored copy once the library has reset, although it is older than what was last saved', async () => {
    const lib = installTestLibrary({ notes: [row(edited)] });
    const client = mount();
    await waitFor(async () => expect((await title()).value).toBe(edited.title));

    // Without a reset an older copy is the stale row of a replayed save, and is ignored.
    await act(async () => {
      lib.upsert('note', row(before));
      await client.invalidateQueries({ queryKey: keys.note(before.id) });
    });
    await waitFor(async () => expect((await title()).value).toBe(edited.title));

    // The wind-back: the feed resets, and the row that comes back is the older one.
    await act(async () => {
      lib.reset();
      lib.upsert('note', row({ ...before, updatedAt: 99 }));
      await client.invalidateQueries({ queryKey: keys.note(before.id) });
    });
    await waitFor(async () => expect((await title()).value).toBe(before.title));
    await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).not.toContain('A line typed today'));
    lib.uninstall();
  });
});
