import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider } from '@tanstack/react-router';
import type { FeedNote, FeedView } from '@unbent/shared';
import * as api from '../notes-api.js';
import * as actions from '../store/actions.js';
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
const NB2 = 'aaaaaaaa-0000-4000-8000-000000000002';
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
    notebooks: [
      { id: NB, name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] },
      { id: NB2, name: 'Projects', purpose: null, emoji: null, fieldDefs: [] },
    ],
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

describe('an edited view', () => {
  /* The chips take a filter off or the pickers add one, and the view's id stays: that
     difference is the edit, said beside the chips with what can be done about it. */
  it('says it has been edited when a tag is added, and goes back on Revert', async () => {
    setup();
    const { router, search } = mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    expect(screen.queryByText('Edited')).toBeNull();

    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, tag: ['Acme', 'Travel'] }) });
    expect(await screen.findByText('Edited')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeTruthy();

    screen.getByRole('button', { name: 'Revert' }).click();
    await waitFor(() => expect(search().tag).toEqual(['Acme']));
    expect(search().saved).toBe(V1);
    await waitFor(() => expect(screen.queryByText('Edited')).toBeNull());
  });

  /* A view does not keep the search, so saving one mid-search would lose it quietly. */
  it('fades Save and Save as new while the search box has text, and keeps Revert', async () => {
    setup();
    const { router } = mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, tag: ['Acme', 'Travel'], q: 'alpha' }) });
    expect(await screen.findByText('Edited')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-description')).toBe('Clear the search to save: a view does not keep it');
    expect((screen.getByRole('button', { name: 'Save as new' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Revert' }) as HTMLButtonElement).disabled).toBe(false);
  });

  /* The search text is not part of a view: typing one inside a view is not wandering. */
  it('does not count a search as an edit', async () => {
    setup();
    const { router } = mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, q: 'alpha' }) });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Edited')).toBeNull();
  });

  it('saves the change into the view', async () => {
    setup();
    vi.mocked(actions.updateView).mockImplementation(async (id, patch) => view({ id, query: patch.query!, updatedAt: 2 }));
    const { router } = mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, tag: ['Acme', 'Travel'] }) });
    (await screen.findByRole('button', { name: 'Save' })).click();
    await waitFor(() =>
      expect(actions.updateView).toHaveBeenCalledWith(V1, { query: { tag: ['Acme', 'Travel'], layout: 'list' } }),
    );
    await waitFor(() => expect(screen.queryByText('Edited')).toBeNull());
  });

  /* Save as new from an edited view opens the new one: its id replaces the edited one's
     in the address, the heading names it, and there is nothing edited about it. */
  it('opens the view Save as new made, in place of the edited one', async () => {
    const made = '66666666-6666-4666-8666-666666666666';
    setup();
    vi.mocked(actions.createView).mockImplementation(async (body) => {
      const row = view({ id: made, name: body.name, position: 1, query: body.query });
      lib?.upsert('view', row);
      return row;
    });
    const { router, search } = mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, tag: ['Acme', 'Travel'] }) });
    (await screen.findByRole('button', { name: 'Save as new' })).click();
    const field = await screen.findByRole('textbox', { name: 'Name for the new view' });
    fireEvent.change(field, { target: { value: 'Acme travel' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(search().saved).toBe(made));
    const heading = await screen.findByRole('heading', { name: 'Acme travel' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByText('Edited')).toBeNull();
    expect(search().tag).toEqual(['Acme', 'Travel']);
  });
});

describe('the view actions in the filter sheet, on a phone', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    // jsdom has no `showModal`; stubbed as in `Sheet.test.tsx`.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  /* The sheet covers the heading, the one place that says what was saved: a save made
     in it closes it, and the heading takes focus once the dialog has let go. */
  it('close the sheet once a save into the view lands, and focus the heading', async () => {
    setup();
    vi.mocked(actions.updateView).mockImplementation(async (id, patch) => view({ id, query: patch.query!, updatedAt: 2 }));
    const { router } = mount(viewAddress());
    const heading = await screen.findByRole('heading', { name: 'Business 2026' });
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, tag: ['Acme', 'Travel'] }) });
    fireEvent.click(await screen.findByRole('button', { name: /^Filter notes/ }));
    // The drawer is a sheet too on a phone: the one wanted holds the view actions.
    const dialog = await waitFor(() => {
      const found = [...document.querySelectorAll('dialog')].find((d) => d.open && d.querySelector('.sheet-view-actions'));
      expect(found).toBeDefined();
      return found!;
    });
    const inSheet = dialog.querySelector('.sheet-view-actions')!;
    fireEvent.click([...inSheet.querySelectorAll('button')].find((b) => b.textContent === 'Save')!);
    await waitFor(() => expect(dialog.open).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe('saving a view', () => {
  it('is offered inside a notebook with a filter or an order, and nowhere else', async () => {
    setup([]);
    const { router } = mount('/notes?notebook=Receipts&view=list');
    await screen.findByRole('heading', { name: 'Receipts' });
    // The notebook as it is: nothing to save that the notebook's own row is not.
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();

    // An order alone is worth saving, though it has no chip.
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, sort: 'title' as const }) });
    expect(await screen.findByRole('button', { name: 'Save view' })).toBeTruthy();

    // Outside a notebook there is nowhere for a view to live.
    await router.navigate({ to: '/notes', search: { tag: ['Acme', 'Travel'], view: 'list' } });
    await screen.findByRole('heading', { name: 'All notes' });
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
  });

  /* The notebook in the order it remembers is the notebook as its rail row opens it. */
  it('is not offered for a notebook in its remembered order alone', async () => {
    localStorage.setItem('unbent.notebookSorts', JSON.stringify({ Receipts: { sort: 'title', order: 'asc' } }));
    setup([]);
    const { router } = mount('/notes?notebook=Receipts&sort=title&order=asc&view=list');
    await screen.findByRole('heading', { name: 'Receipts' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
    // No row is drawn for nothing: the chips row holds neither chips nor the button.
    expect(document.querySelector('.sidebar > .filter-chips')).toBeNull();

    // Another order than the remembered one is something to save.
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, sort: 'updated' as const, order: undefined }) });
    expect(await screen.findByRole('button', { name: 'Save view' })).toBeTruthy();
  });

  /* A view does not keep the search, so one saved mid-search would open to more notes. */
  it('is held back while the search box has text', async () => {
    setup([]);
    const { router } = mount('/notes?notebook=Receipts&tag=%5B%22Acme%22%5D&view=list');
    expect(await screen.findByRole('button', { name: 'Save view' })).toBeTruthy();
    await router.navigate({ to: '/notes', search: (prev: Record<string, unknown>) => ({ ...prev, q: 'alpha' }) });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull());
  });

  it('is not offered with a view open', async () => {
    setup();
    mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
  });

  it('names the view in place, saves it, and opens it', async () => {
    const made = '44444444-4444-4444-8444-444444444444';
    setup([]);
    vi.mocked(actions.createView).mockImplementation(async (body) => {
      const row = view({ id: made, name: body.name, query: body.query });
      lib?.upsert('view', row);
      return row;
    });
    const { search } = mount('/notes?notebook=Receipts&tag=%5B%22Acme%22%5D&view=list');
    (await screen.findByRole('button', { name: 'Save view' })).click();
    const field = await screen.findByRole('textbox', { name: 'View name' });
    fireEvent.change(field, { target: { value: 'Acme only' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() =>
      expect(actions.createView).toHaveBeenCalledWith({ notebookId: NB, name: 'Acme only', query: { tag: ['Acme'], layout: 'list' } }),
    );
    await waitFor(() => expect(search().saved).toBe(made));
    const heading = await screen.findByRole('heading', { name: 'Acme only' });
    // The control that saved it is gone; the heading naming the new view has focus.
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  /* The save waits for its row; a person who has gone elsewhere meanwhile stays there. */
  it('does not open the view in another notebook the person moved to while it saved', async () => {
    const made = '55555555-5555-4555-8555-555555555555';
    setup([]);
    let land: (() => void) | undefined;
    vi.mocked(actions.createView).mockImplementation(
      (body) =>
        new Promise((resolve) => {
          land = () => {
            const row = view({ id: made, name: body.name, query: body.query });
            lib?.upsert('view', row);
            resolve(row);
          };
        }),
    );
    const { router, search } = mount('/notes?notebook=Receipts&tag=%5B%22Acme%22%5D&view=list');
    (await screen.findByRole('button', { name: 'Save view' })).click();
    const field = await screen.findByRole('textbox', { name: 'View name' });
    fireEvent.change(field, { target: { value: 'Acme only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(land).toBeDefined());

    await router.navigate({ to: '/notes', search: { notebook: 'Projects', view: 'list' } });
    await screen.findByRole('heading', { name: 'Projects' });
    land!();
    await new Promise((r) => setTimeout(r, 50));
    expect(search().notebook).toBe('Projects');
    expect(search().saved).toBeUndefined();
  });

  it('hands focus back to Save view when naming is cancelled', async () => {
    setup([]);
    mount('/notes?notebook=Receipts&tag=%5B%22Acme%22%5D&view=list');
    (await screen.findByRole('button', { name: 'Save view' })).click();
    await screen.findByRole('textbox', { name: 'View name' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save view' })));
  });

  /* A taken name is about the field, so it is said under the field, which keeps the name. */
  it('says under the field when the name is taken', async () => {
    setup();
    vi.mocked(actions.createView).mockRejectedValue(new Error('This notebook already has a view with that name.'));
    mount('/notes?notebook=Receipts&tag=%5B%22Travel%22%5D&view=list');
    (await screen.findByRole('button', { name: 'Save view' })).click();
    const field = await screen.findByRole('textbox', { name: 'View name' });
    fireEvent.change(field, { target: { value: 'Business 2026' } });
    screen.getByRole('button', { name: 'Save' }).click();
    expect((await screen.findByRole('alert')).textContent).toBe('This notebook already has a view with that name.');
    expect((screen.getByRole('textbox', { name: 'View name' }) as HTMLInputElement).value).toBe('Business 2026');
  });
});

describe("an open view's menu", () => {
  it('renames the view in place of its name', async () => {
    setup();
    vi.mocked(actions.updateView).mockImplementation(async (id, patch) => {
      const row = view({ id, name: patch.name!, updatedAt: 2 });
      lib?.upsert('view', row);
      return row;
    });
    mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Business 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const field = await screen.findByRole('textbox', { name: 'New name for Business 2026' });
    expect((field as HTMLInputElement).value).toBe('Business 2026');
    fireEvent.change(field, { target: { value: 'Business 2027' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(actions.updateView).toHaveBeenCalledWith(V1, { name: 'Business 2027' }));
    const heading = await screen.findByRole('heading', { name: 'Business 2027' });
    // The field and its buttons are gone; the heading that changed has focus.
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  /* Left without a rename, focus goes back to the ⋯ it was opened from. */
  it('hands focus back to the menu when a rename is cancelled', async () => {
    setup();
    mount(viewAddress());
    await screen.findByRole('heading', { name: 'Business 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Business 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const field = await screen.findByRole('textbox', { name: 'New name for Business 2026' });
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Business 2026' })),
    );
  });

  /* Named, and confirmed in place, then out to the notebook as it is. */
  it('deletes the view after a confirm that names it, and opens the notebook', async () => {
    setup();
    vi.mocked(actions.deleteView).mockImplementation(async (id) => {
      lib?.remove('view', id);
    });
    const { search } = mount(viewAddress('&sort=title'));
    await screen.findByRole('heading', { name: 'Business 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Business 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('group', { name: 'Confirm delete view' });
    expect(confirm.textContent).toContain('Delete the view “Business 2026”?');
    expect(confirm.textContent).toContain('Its notes stay where they are.');
    expect(actions.deleteView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(actions.deleteView).toHaveBeenCalledWith(V1));
    await waitFor(() => expect(search().saved).toBeUndefined());
    expect(search().notebook).toBe('Receipts');
    expect(search().tag).toBeUndefined();
    expect(search().sort).toBeUndefined();
    expect(await screen.findByRole('heading', { name: 'Receipts' })).toBeTruthy();
  });
});
