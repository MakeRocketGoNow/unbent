import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { FeedNote, NoteSummary } from '@unbent/shared';
import * as api from '../notes-api.js';
import { installTestLibrary, type TestLibrary } from '../store/test-library.js';
import { installLibraryQueries } from '../queries.js';
import { NotesLayout } from '../components/NotesLayout.js';
import { filters } from './notes.js';

/**
 * The cards inside the notes view, against a real router and the in-memory library: the
 * view the URL names is the one drawn and every list's URL names one, a search keeps the
 * cards and says why each matched, and a selection reaches the matches as it reaches the
 * table's rows. `NoteCard` alone is tested beside it; this is the wiring.
 *
 * The routes are rebuilt rather than taken from the generated tree, as
 * `notes-empty-library.test.tsx` does, so no session gate or loaders stand in the way.
 */

vi.mock('../useAppSession.js', () => ({
  useAppSession: () => ({ session: { user: { id: 'u1', email: 'someone@example.com' } }, isPending: false, unreachable: false }),
}));
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
  searchNotes: vi.fn(),
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

const summary = (id: string, title: string): NoteSummary => ({ id, title, createdAt: 1, updatedAt: 1, tags: [] });

function setWidth(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 860px)' ? phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

let lib: TestLibrary | null = null;
let stopLibraryQueries: (() => void) | null = null;

function mount(initial: string) {
  const rootRoute = createRootRoute({ component: Outlet });
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
  const indexRoute = createRoute({ getParentRoute: () => notesRoute, path: '/', component: () => null });
  const noteRoute = createRoute({ getParentRoute: () => notesRoute, path: '$noteId', component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute.addChildren([indexRoute, noteRoute])]),
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

const list = () => document.querySelector<HTMLElement>('.note-list');

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [] } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
  lib = installTestLibrary({ notes: [note('a', { title: 'Alpha' }), note('b', { title: 'Beta' })] });
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

describe('the cards in the notes view', () => {
  it('draws the cards a link names, on a phone too, as a grid the arrows read as one', async () => {
    setWidth(true);
    mount('/notes?view=cards');
    await screen.findByText('Alpha');
    expect(list()?.classList.contains('cards')).toBe(true);
    expect(list()?.hasAttribute('data-grid')).toBe(true);
    expect(document.querySelectorAll('.note-card')).toHaveLength(2);
  });

  /* Every list's history entry names its view, outside a notebook and on a phone too, so
     Back brings back the view that was on screen. */
  it('writes the view on screen into a URL that does not name one, outside a notebook', async () => {
    setWidth(true);
    localStorage.setItem('unbent.notesView', '"cards"');
    const router = mount('/notes');
    await screen.findByText('Alpha');
    await waitFor(() => expect(router.state.location.href).toContain('view=cards'));
    expect(list()?.classList.contains('cards')).toBe(true);
  });

  it('keeps the cards for a search, asks for the rows, and says why each matched', async () => {
    setWidth(false);
    vi.mocked(api.searchNotes).mockResolvedValue([
      { id: 'a', title: 'Alpha', updatedAt: 1, snippet: '', matchedField: 'Amount', note: summary('a', 'Alpha') },
      { id: 'b', title: 'Beta', updatedAt: 1, snippet: '', matchedFile: 'Scan.pdf', note: summary('b', 'Beta') },
    ]);
    mount('/notes?view=cards&q=acme');
    expect(await screen.findByText('in Amount')).toBeTruthy();
    expect(screen.getByText('in Scan.pdf')).toBeTruthy();
    expect(vi.mocked(api.searchNotes).mock.calls[0]?.[2]).toBe(true);
    expect(list()?.classList.contains('cards')).toBe(true);
    // Not the sidebar's results, which draw a snippet instead.
    expect(document.querySelectorAll('.note-card')).toHaveLength(2);
  });

  it('says there are no matches in the cards, as the list does', async () => {
    setWidth(false);
    vi.mocked(api.searchNotes).mockResolvedValue([]);
    mount('/notes?view=cards&q=nothing');
    expect(await screen.findByText('No matches.')).toBeTruthy();
    expect(document.querySelector('.note-card')).toBeNull();
  });

  /* Cmd/Ctrl+A over a search's matches selects them in the cards, as in the table. */
  it('selects every match with Cmd+A', async () => {
    setWidth(false);
    vi.mocked(api.searchNotes).mockResolvedValue([
      { id: 'a', title: 'Alpha', updatedAt: 1, snippet: '', note: summary('a', 'Alpha') },
      { id: 'b', title: 'Beta', updatedAt: 1, snippet: '', note: summary('b', 'Beta') },
    ]);
    mount('/notes?view=cards&q=acme');
    await screen.findAllByText('Alpha');
    fireEvent.keyDown(list()!, { key: 'a', metaKey: true });
    await waitFor(() => expect(document.querySelectorAll('.note-card.selected')).toHaveLength(2));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });
});
