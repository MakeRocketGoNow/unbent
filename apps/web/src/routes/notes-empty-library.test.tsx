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
import type { FeedNote, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import * as actions from '../store/actions.js';
import { installTestLibrary, type TestLibrary } from '../store/test-library.js';
import { installLibraryQueries } from '../queries.js';
import { NotesLayout } from '../components/NotesLayout.js';
import { filters } from './notes.js';
import { Route as IndexRoute } from './notes.index.js';
import { WELCOME_TITLE } from '../welcome-note.js';

/**
 * Where an empty account's empty state is drawn, and the missing-notebook state, against
 * a real router and the in-memory library.
 *
 * The routes are rebuilt rather than taken from the generated tree, as the settings
 * routing test does, so no session gate, loaders or API stand in the way: `/notes` with
 * the real search schema and the real layout around the real index component, and a
 * note route that only says which note it is.
 */

let session: { user: { id: string; email: string } } | null = null;
vi.mock('../useAppSession.js', () => ({
  useAppSession: () => ({ session, isPending: false, unreachable: false }),
}));
/** Every `enabled` the notes view asked `useLibraryTotal` with, to see who counts when. */
const totalAsked: boolean[] = [];
vi.mock('../useLibraryTotal.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../useLibraryTotal.js')>();
  return {
    ...real,
    useLibraryTotal: (enabled?: boolean) => {
      totalAsked.push(enabled ?? true);
      return real.useLibraryTotal(enabled);
    },
  };
});
vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  createNote: vi.fn(),
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
    // The real route loads the note before it commits; a moment's wait stands in for that,
    // which is the moment a view must not fill with something else.
    loader: () => new Promise((resolve) => setTimeout(resolve, 20)),
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
  // As the app does: a change to the library re-runs the queries that read it.
  stopLibraryQueries = installLibraryQueries(client);
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
let stopLibraryQueries: (() => void) | null = null;

beforeEach(() => {
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [] } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
  session = { user: { id: 'u1', email: 'someone@example.com' } };
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

describe('the workspace pane with no note open, on a desktop', () => {
  beforeEach(() => setWidth(false));

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

  /** An account with notes must not recount on every change just because the pane is on screen. */
  it('does not ask for the total once the column shows a note', async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Alpha' })] });
    const { router } = mount('/notes');
    await screen.findByText('Alpha');
    await screen.findByText('Select a note, or create one.');
    // A change of order re-renders both the column and the pane over the same rows.
    totalAsked.length = 0;
    await router.navigate({ to: '/notes', search: { sort: 'title' } });
    await waitFor(() => expect(router.state.location.href).toContain('sort=title'));
    await screen.findByText('Alpha');
    expect(totalAsked.length).toBeGreaterThan(0);
    expect(totalAsked.every((enabled) => !enabled)).toBe(true);
  });

  /** The list's first load is empty for every account; counting then would walk an archive on every open. */
  it("does not ask for the total while a full account's list first loads", async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Alpha' })] });
    totalAsked.length = 0;
    mount('/notes');
    await screen.findByText('Alpha');
    await screen.findByText('Select a note, or create one.');
    expect(totalAsked.length).toBeGreaterThan(0);
    expect(totalAsked.every((enabled) => !enabled)).toBe(true);
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

  /* The state's own New note is the action; a floating + beside it is a second filled
     control and a second "New note". */
  it("draws one New note, the state's, without the floating +", async () => {
    lib = installTestLibrary({ notes: [] });
    mount('/notes');
    await waitFor(() => expect(region()).not.toBeNull());
    expect(screen.getAllByRole('button', { name: 'New note' })).toHaveLength(1);
    expect(document.querySelector('.fab')).toBeNull();
  });

  /** A library still arriving: the total is unknown, so neither the state nor the line. */
  it('says nothing on All notes while the total is unknown', async () => {
    lib = installTestLibrary({ notes: [], cursor: null });
    mount('/notes');
    await new Promise((r) => setTimeout(r, 50));
    expect(region()).toBeNull();
    expect(screen.queryByText('No notes yet.')).toBeNull();
  });

  it('draws the list, not the empty state, for an account with one note', async () => {
    lib = installTestLibrary({ notes: [note('only', { title: 'Shopping list' })] });
    const { router } = mount('/notes');
    await screen.findByText('Shopping list');
    expect(region()).toBeNull();
    expect(router.state.location.pathname).toBe('/notes');
  });
});

/**
 * "See a sample note": one note, with the sample's title, made through the same action as
 * New and opened, after which the account is not empty and the state is gone. The note
 * lands in the in-memory library as a real create would put it in the local copy.
 */
describe('asking for the sample note', () => {
  function makesNotes() {
    vi.mocked(actions.createNote).mockImplementation(async (input) => {
      lib!.upsert('note', note('sample', { title: input.title }));
      return { id: 'sample' } as Note;
    });
  }

  /** Every text the page showed while the note was being made, to catch a one-frame flash. */
  function watchFor(text: string): () => boolean {
    let seen = false;
    // From the records rather than the page as it stands when the observer runs: a node
    // added and removed again within one batch is gone by then, and that is the flash.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.textContent?.includes(text)) seen = true;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      return seen;
    };
  }

  for (const phone of [false, true]) {
    it(`makes one note and opens it, and the empty state is gone, on a ${phone ? 'phone' : 'desktop'}`, async () => {
      setWidth(phone);
      lib = installTestLibrary({ notes: [] });
      makesNotes();
      const { router } = mount('/notes');
      const sample = await screen.findByRole('button', { name: 'See a sample note' });
      const sawSelect = watchFor('Select a note, or create one.');
      fireEvent.click(sample);
      fireEvent.click(sample);
      await screen.findByText('open note sample');
      expect(router.state.location.pathname).toBe('/notes/sample');
      expect(actions.createNote).toHaveBeenCalledTimes(1);
      expect(vi.mocked(actions.createNote).mock.calls[0]?.[0]).toMatchObject({ title: WELCOME_TITLE, notebook: null, tags: [] });
      // No "Select a note" between the empty state and the note opening.
      expect(sawSelect()).toBe(false);
      await waitFor(() => expect(region()).toBeNull());
    });
  }
});

/** A link that names a notebook the account does not have: one statement, in the list's place. */
describe('a link to a notebook that is not there', () => {
  const coupons = { id: 'nb1', name: 'Coupons', purpose: null, emoji: null, fieldDefs: [] };

  for (const phone of [false, true]) {
    it(`says so in the list column, without the empty line or a count, on a ${phone ? 'phone' : 'desktop'}`, async () => {
      setWidth(phone);
      lib = installTestLibrary({ notes: [note('a', { notebookId: 'nb1' })], notebooks: [coupons] });
      mount('/notes?notebook=Gone');
      const found = await screen.findByRole('region', { name: 'Notebook not found' });
      expect(found.closest('.sidebar')).not.toBeNull();
      expect(screen.queryByText(/No notes in/)).toBeNull();
      // The heading keeps the name the link asked for; its count line stays, empty.
      expect(screen.getByRole('heading', { level: 2, name: 'Gone' })).toBeTruthy();
      expect(document.querySelector('.list-title .count')?.textContent).toBe(' ');
      expect(screen.queryByText('0 notes')).toBeNull();
    });
  }

  /**
   * New beside "Notebook not found" files the note nowhere — filing it under the name
   * would make the server create the notebook the screen says is not there — and the
   * desktop's New is outlined there, as it is for an empty account.
   */
  it("makes New's note in no notebook, from the desktop's outlined New and the phone's +", async () => {
    vi.mocked(actions.createNote).mockResolvedValue({ id: 'made' } as Note);
    for (const phone of [false, true]) {
      setWidth(phone);
      lib = installTestLibrary({ notes: [note('a', { notebookId: 'nb1' })], notebooks: [coupons] });
      mount('/notes?notebook=Gone');
      await screen.findByRole('region', { name: 'Notebook not found' });
      const control = phone
        ? screen.getByRole('button', { name: 'New note' })
        : screen.getByRole('button', { name: 'New' });
      if (!phone) expect(control.className).toContain('btn-secondary');
      fireEvent.click(control);
      await waitFor(() => expect(actions.createNote).toHaveBeenCalled());
      expect(vi.mocked(actions.createNote).mock.calls.at(-1)?.[0]).toMatchObject({ notebook: null });
      cleanup();
      lib.uninstall();
      lib = null;
      vi.mocked(actions.createNote).mockClear();
    }
  });

  /** A search is someone looking for something: its results win, and clearing it brings the state back. */
  it('gives way to a search, and comes back when the query is cleared', async () => {
    setWidth(false);
    vi.mocked(api.searchNotes).mockResolvedValue([]);
    lib = installTestLibrary({ notes: [note('a', { notebookId: 'nb1' })], notebooks: [coupons] });
    const { router } = mount('/notes?notebook=Gone&q=coup');
    // The notebook whose name matches is offered, the count says the matches, no state.
    await screen.findByText('0 matches');
    expect(document.querySelector('.note-list')?.textContent).toContain('Coupons');
    expect(screen.queryByRole('region', { name: 'Notebook not found' })).toBeNull();

    await router.navigate({ to: '/notes', search: { notebook: 'Gone' } });
    await screen.findByRole('region', { name: 'Notebook not found' });
  });

  it('draws nothing of the kind for a notebook that exists', async () => {
    setWidth(false);
    lib = installTestLibrary({ notes: [], notebooks: [coupons] });
    mount('/notes?notebook=Coupons');
    await screen.findByText('No notes in Coupons.');
    expect(screen.queryByRole('region', { name: 'Notebook not found' })).toBeNull();
  });
});
