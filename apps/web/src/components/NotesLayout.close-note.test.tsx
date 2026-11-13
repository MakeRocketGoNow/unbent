import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider } from '@tanstack/react-router';
import type { FeedNote } from '@unbent/shared';
import * as api from '../notes-api.js';
import { installTestLibrary, type TestLibrary } from '../store/test-library.js';
import { installLibraryQueries } from '../queries.js';
import { NotesLayout } from './NotesLayout.js';
import { filters } from '../routes/notes.js';
import { trackWhatIsBehind } from '../note-nav.js';

/**
 * Getting back from a note to the table or the cards it was opened beside: a row opens
 * its note in place of the one already open, so Back is the list from any of them. Not
 * beside the plain list, where the note is the page. Against the real layout, the in-memory library and a real memory history, with
 * the record of what is behind each entry kept as the app keeps it.
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

const NB = 'aaaaaaaa-0000-4000-8000-000000000001';

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

let lib: TestLibrary | null = null;
let stopLibraryQueries: (() => void) | null = null;

function setup() {
  lib = installTestLibrary({
    notes: [note('a', { title: 'Alpha' }), note('b', { title: 'Beta' }), note('c', { title: 'Gamma' })],
    notebooks: [
      { id: NB, name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] },
    ],
    tags: [],
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
  const noteRoute = createRoute({ getParentRoute: () => notesRoute, path: '$noteId', component: () => <p>a note</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute.addChildren([indexRoute, noteRoute])]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trackWhatIsBehind(router as any);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stopLibraryQueries = installLibraryQueries(client);
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  const path = () => router.state.location.pathname;
  // The router's own parsed search: the router owns the location (`url-boundary.test.ts`).
  const search = () => {
    const { search: parsed } = router.state.location;
    return parsed as Record<string, unknown>;
  };
  return { router, path, search };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // Not a phone: the table and the note sit side by side.
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

const TABLE = '/notes?notebook=Receipts&view=table';
const CARDS = '/notes?notebook=Receipts&view=cards';
const LIST = '/notes?notebook=Receipts&view=list';

const row = (name: string) => screen.findByRole('link', { name: new RegExp(name) });

async function open(name: string, path: () => string, id: string) {
  fireEvent.click(await row(name));
  await waitFor(() => expect(path()).toBe(`/notes/${id}`));
}

describe('opening one note after another beside a table', () => {
  it('leaves the table one step back, however many rows were opened', async () => {
    setup();
    const { router, path, search } = mount(TABLE);
    await open('Alpha', path, 'a');
    await open('Beta', path, 'b');
    await open('Gamma', path, 'c');

    router.history.back();
    await waitFor(() => expect(path()).toBe('/notes'));
    expect(search()).toMatchObject({ notebook: 'Receipts', view: 'table' });
  });

  it('does the same beside the cards', async () => {
    setup();
    const { router, path } = mount(CARDS);
    await open('Alpha', path, 'a');
    await open('Beta', path, 'b');

    router.history.back();
    await waitFor(() => expect(path()).toBe('/notes'));
  });

  it('still steps back through the notes beside the plain list', async () => {
    setup();
    const { router, path } = mount(LIST);
    await open('Alpha', path, 'a');
    await open('Beta', path, 'b');

    router.history.back();
    await waitFor(() => expect(path()).toBe('/notes/a'));
  });
});
