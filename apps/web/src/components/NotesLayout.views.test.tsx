import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider } from '@tanstack/react-router';
import type { FeedNote, FeedView } from '@unbent/shared';
import * as api from '../notes-api.js';
import { installTestLibrary, type TestLibrary } from '../store/test-library.js';
import { installLibraryQueries } from '../queries.js';
import { NotesLayout } from './NotesLayout.js';
import { filters } from '../routes/notes.js';

/**
 * Saved views from the list's side: the heading names the open one, an edit shows as
 * one, and a view can be saved, saved over, renamed and deleted from here. Against the
 * real layout and the in-memory library, with the view actions mocked as the server.
 */

vi.mock('../useAppSession.js', () => ({
  useAppSession: () => ({ session: { user: { id: 'u1', email: 'someone@example.com' } }, isPending: false, unreachable: false }),
}));
vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  createView: vi.fn(),
  updateView: vi.fn(),
  deleteView: vi.fn(),
}));
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
  searchNotes: vi.fn(),
}));
vi.mock('../index-files.js', () => ({ indexUploadedFile: vi.fn(), useIndexing: () => ({ queued: 0, running: false, failed: 0 }) }));

const NB = 'aaaaaaaa-0000-4000-8000-000000000001';
const V1 = '11111111-1111-4111-8111-111111111111';
const GONE = '99999999-9999-4999-8999-999999999999';

const note = (id: string, over: Partial<FeedNote> = {}): FeedNote => ({
  id,
  title: id,
  body: '',
  createdAt: 1,
  updatedAt: 1,
  tagIds: [],
  notebookId: NB,
  files: [],
  ...over,
});

const view = (over: Partial<FeedView> = {}): FeedView => ({
  id: V1,
  notebookId: NB,
  name: 'Business 2026',
  position: 0,
  query: { tag: ['Acme'], layout: 'list' },
  updatedAt: 1,
  ...over,
});

let lib: TestLibrary | null = null;
let stopLibraryQueries: (() => void) | null = null;

function setup(views: FeedView[] = [view()]) {
  lib = installTestLibrary({
    notes: [note('a', { title: 'Alpha', tagIds: ['t1'] }), note('b', { title: 'Beta' })],
    notebooks: [{ id: NB, name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] }],
    tags: [
      { id: 't1', name: 'Acme', color: null },
      { id: 't2', name: 'Travel', color: null },
    ],
    views,
  });
  return lib;
}

function mount(initial: string) {
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
  // The router's own parsed search: the router owns the location (`url-boundary.test.ts`).
  const search = () => {
    const { search: parsed } = router.state.location;
    return parsed as Record<string, unknown>;
  };
  return { router, search };
}

const viewAddress = (extra = '') => `/notes?notebook=Receipts&saved=${V1}&tag=%5B%22Acme%22%5D&view=list${extra}`;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [] } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
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

describe('the heading of a saved view', () => {
  it("names the view, with its notebook over it", async () => {
    setup();
    mount(viewAddress());
    const heading = await screen.findByRole('heading', { name: 'Business 2026' });
    expect(heading.closest('.list-title')?.querySelector('.list-eyebrow')?.textContent).toBe('Receipts');
  });

  it('names the notebook alone, with no line over it, when no view is open', async () => {
    setup();
    mount('/notes?notebook=Receipts&view=list');
    const heading = await screen.findByRole('heading', { name: 'Receipts' });
    expect(heading.closest('.list-title')?.querySelector('.list-eyebrow')).toBeNull();
  });

  /* Deleted on another device, or an old link: the notebook, with the link's filters. */
  it('drops a saved id that names no view, in place, and keeps the filters', async () => {
    setup();
    const { search } = mount(`/notes?notebook=Receipts&saved=${GONE}&tag=%5B%22Acme%22%5D&view=list`);
    await waitFor(() => expect(search().saved).toBeUndefined());
    expect(search().tag).toEqual(['Acme']);
    expect(await screen.findByRole('heading', { name: 'Receipts' })).toBeTruthy();
  });

  /* A view keeps its own order: the notebook's remembered one must not be written in. */
  it("does not seed the notebook's remembered order into a view", async () => {
    localStorage.setItem('unbent.notebookSorts', JSON.stringify({ Receipts: { sort: 'title', order: 'asc' } }));
    setup();
    const { search } = mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    // Give the arrival effect its chance to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(search().sort).toBeUndefined();
  });
});
