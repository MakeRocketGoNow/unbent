import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider } from '@tanstack/react-router';
import type { FeedNote } from '@unbent/shared';
import * as api from '../notes-api.js';
import { installTestLibrary, type TestLibrary } from '../store/test-library.js';
import { installLibraryQueries } from '../queries.js';
import { NotesLayout } from './NotesLayout.js';
import { filters } from '../routes/notes.js';

/**
 * Leaving a search for another place ends it at once. The term is debounced for typing,
 * and read through that wait a place picked from the rail drew the last place's matches,
 * dimmed, and asked the server for the old words under the new notebook's filter, before
 * its own list came. Against the real layout and the in-memory library, with the server's
 * search mocked.
 */

vi.mock('../useAppSession.js', () => ({
  useAppSession: () => ({ session: { user: { id: 'u1', email: 'someone@example.com' } }, isPending: false, unreachable: false }),
}));
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
  searchNotes: vi.fn(),
}));
vi.mock('../index-files.js', () => ({ indexUploadedFile: vi.fn(), useIndexing: () => ({ queued: 0, running: false, failed: 0 }) }));

const RECEIPTS = 'aaaaaaaa-0000-4000-8000-000000000001';
const RECIPES = 'aaaaaaaa-0000-4000-8000-000000000002';

const note = (id: string, title: string, notebookId: string): FeedNote => ({
  id,
  title,
  body: '',
  createdAt: 1,
  updatedAt: 1,
  tagIds: [],
  notebookId,
  files: [],
});

let lib: TestLibrary | null = null;
let stopLibraryQueries: (() => void) | null = null;

function mount(initial: string) {
  lib = installTestLibrary({
    notes: [note('a', 'Milk receipt', RECEIPTS), note('b', 'Sourdough', RECIPES)],
    notebooks: [
      { id: RECEIPTS, name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] },
      { id: RECIPES, name: 'Recipes', purpose: null, emoji: null, fieldDefs: [] },
    ],
    tags: [],
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    validateSearch: filters,
    component: () => (
      <NotesLayout>
        <Outlet />
      </NotesLayout>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => notesRoute, path: '/', component: () => <p>nothing open</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute.addChildren([indexRoute])]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stopLibraryQueries = installLibraryQueries(client);
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [] } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
  vi.mocked(api.searchNotes).mockResolvedValue([{ id: 'a', title: 'Milk receipt', updatedAt: 1, snippet: '' }]);
});

afterEach(() => {
  cleanup();
  stopLibraryQueries?.();
  stopLibraryQueries = null;
  lib?.uninstall();
  lib = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('leaving a search for another place', () => {
  it('draws the new place at once and never searches it for the old words', async () => {
    const router = mount('/notes?notebook=Receipts&q=milk');
    await waitFor(() => expect(api.searchNotes).toHaveBeenCalledWith('milk', expect.objectContaining({ notebook: 'Receipts' }), false));
    await screen.findByText('Milk receipt');

    // What the rail's link for Recipes writes: the notebook, and no `q`.
    await router.navigate({ to: '/notes', search: { notebook: 'Recipes' } });
    // Well inside the 300 ms the typing wait would have held the old term for.
    await screen.findByText('Sourdough', undefined, { timeout: 200 });
    expect(screen.queryByText('Milk receipt')).toBeNull();

    // Past the wait, too: the old words were never asked of the new place.
    await new Promise((r) => setTimeout(r, 400));
    const underRecipes = vi.mocked(api.searchNotes).mock.calls.filter(([, filter]) => filter?.notebook === 'Recipes');
    expect(underRecipes).toEqual([]);
  });

  it('starts the next search from nothing, not from the term that was cleared', async () => {
    const router = mount('/notes?notebook=Receipts&q=milk');
    await waitFor(() => expect(api.searchNotes).toHaveBeenCalledWith('milk', expect.objectContaining({ notebook: 'Receipts' }), false));

    await router.navigate({ to: '/notes', search: { notebook: 'Recipes' } });
    await screen.findByText('Sourdough');
    // A letter typed inside the wait, as the field writes it.
    await router.navigate({ to: '/notes', search: (prev) => ({ ...prev, q: 's' }), replace: true });

    await waitFor(() => expect(api.searchNotes).toHaveBeenCalledWith('s', expect.objectContaining({ notebook: 'Recipes' }), false));
    const underRecipes = vi.mocked(api.searchNotes).mock.calls.filter(([, filter]) => filter?.notebook === 'Recipes');
    expect(underRecipes.map(([term]) => term)).toEqual(['s']);
  });
});
