import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { FeedNote } from '@unbent/shared';
import * as api from '../notes-api.js';
import { installTestLibrary, type TestLibrary } from '../store/test-library.js';
import { NotesLayout } from '../components/NotesLayout.js';
import { filters } from './notes.js';
import { Route as IndexRoute } from './notes.index.js';

/**
 * Where an empty account's empty state is drawn, and the first-run opening of the welcome
 * note, against a real router and the in-memory library.
 *
 * The routes are rebuilt rather than taken from the generated tree, as the settings
 * routing test does, so no session gate, loaders or API stand in the way: `/notes` with
 * the real search schema and the real layout around the real index component, and a
 * note route that only says which note it is.
 */

let session: { user: { id: string; email: string; createdAt?: Date | string } } | null = null;
vi.mock('../useAppSession.js', () => ({
  useAppSession: () => ({ session, isPending: false, unreachable: false }),
}));
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
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

/** Phone or desktop, as `useMediaQuery` reads the layout's breakpoint. */
function setWidth(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 860px)' ? phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

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
  const indexRoute = createRoute({
    getParentRoute: () => notesRoute,
    path: '/',
    component: IndexRoute.options.component!,
  });
  const noteRoute = createRoute({
    getParentRoute: () => notesRoute,
    path: '$noteId',
    component: function OpenNote() {
      return <p>open note {noteRoute.useParams().noteId}</p>;
    },
  });
  const importRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/import' });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute.addChildren([indexRoute, noteRoute]), importRoute]),
    history,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { router, history };
}

const region = () => screen.queryByRole('region', { name: 'No notes yet' });

let lib: TestLibrary | null = null;

beforeEach(() => {
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [] } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
  session = { user: { id: 'u1', email: 'someone@example.com', createdAt: new Date(Date.now() - 60_000) } };
});

afterEach(() => {
  cleanup();
  lib?.uninstall();
  lib = null;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the workspace pane with no note open, on a desktop', () => {
  beforeEach(() => setWidth(false));

  it("opens a brand-new account's one note in place, and remembers that it did", async () => {
    lib = installTestLibrary({ notes: [note('welcome')] });
    const { router, history } = mount('/notes');
    await screen.findByText('open note welcome');
    expect(router.state.location.pathname).toBe('/notes/welcome');
    // Replaced, not pushed: there is no `/notes` entry to go Back to.
    expect(history.length).toBe(1);
    const stored = JSON.parse(localStorage.getItem('unbent.firstNoteOpened')!);
    expect(stored.map((e: { id: string }) => e.id)).toEqual(['u1']);
  });

  it('does it once: a second visit to the list leaves the pane alone', async () => {
    lib = installTestLibrary({ notes: [note('welcome')] });
    mount('/notes');
    await screen.findByText('open note welcome');
    cleanup();

    const { router } = mount('/notes');
    await screen.findByText('Select a note, or create one.');
    expect(router.state.location.pathname).toBe('/notes');
  });

  it('draws the empty state in the pane, and no line in the list column, for an empty account', async () => {
    lib = installTestLibrary({ notes: [] });
    mount('/notes');
    const pane = await waitFor(() => {
      const found = region();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(pane.closest('.workspace')).not.toBeNull();
    expect(screen.queryByText('No notes yet.')).toBeNull();
    // The header's New is outlined while the pane's import is the one filled control.
    expect(screen.getByRole('button', { name: 'New' }).className).toContain('btn-secondary');
  });

  it('says "Select a note" inside a notebook, however empty the account', async () => {
    lib = installTestLibrary({ notes: [] });
    mount('/notes?notebook=Coupons');
    await screen.findByText('Select a note, or create one.');
    expect(region()).toBeNull();
  });
});

describe('the list with an empty account, on a phone', () => {
  beforeEach(() => setWidth(true));

  it('draws the empty state in place of the list', async () => {
    lib = installTestLibrary({ notes: [] });
    mount('/notes');
    const found = await waitFor(() => {
      const r = region();
      expect(r).not.toBeNull();
      return r!;
    });
    expect(found.closest('.sidebar')).not.toBeNull();
    expect(found.querySelector('h3')?.textContent).toBe('No notes yet');
  });

  /** A library still arriving: the total is unknown, so neither the state nor the line. */
  it('says nothing on All notes while the total is unknown', async () => {
    lib = installTestLibrary({ notes: [], cursor: null });
    mount('/notes');
    await new Promise((r) => setTimeout(r, 50));
    expect(region()).toBeNull();
    expect(screen.queryByText('No notes yet.')).toBeNull();
  });

  it('leaves a phone on its list when the account has one note', async () => {
    lib = installTestLibrary({ notes: [note('welcome', { title: 'Welcome to Unbent' })] });
    const { router } = mount('/notes');
    await screen.findByText('Welcome to Unbent');
    expect(region()).toBeNull();
    expect(router.state.location.pathname).toBe('/notes');
  });
});
