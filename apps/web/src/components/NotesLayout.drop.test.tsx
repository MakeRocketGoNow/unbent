import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider } from '@tanstack/react-router';
import type { FeedNote, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import * as actions from '../store/actions.js';
import { installTestLibrary, type TestLibrary } from '../store/test-library.js';
import { installLibraryQueries } from '../queries.js';
import { claimFileNotesFor, resetFileNotesForTests } from '../file-notes.js';
import { NotesLayout } from './NotesLayout.js';
import { FileNotesSnackbar } from './FileNotesSnackbar.js';
import { filters } from '../routes/notes.js';

/**
 * Files let go on the list column become one note each, filed where the list is, and are
 * selected once they are in it, against the real layout and the in-memory library. The
 * zone's own rules are `list-drop-zone.test.ts`; the writes are `file-notes.test.ts`.
 *
 * jsdom has neither DragEvent nor DataTransfer, so the transfer is a plain object on a
 * plain event, as the note's drop test builds it.
 */

let session: { user: { id: string; email: string } } | null = null;
vi.mock('../useAppSession.js', () => ({
  useAppSession: () => ({ session, isPending: false, unreachable: false }),
}));
vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  createNote: vi.fn(),
  synced: vi.fn(async () => true),
  uploadFile: vi.fn(),
  saveNote: vi.fn(),
  trashNotes: vi.fn(),
}));
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
  searchNotes: vi.fn(),
}));
vi.mock('../index-files.js', () => ({ indexUploadedFile: vi.fn(), useIndexing: () => ({ queued: 0, running: false, failed: 0 }) }));
let planInactive = false;
vi.mock('../use-plan.js', () => ({ usePlan: () => ({ inactive: planInactive }) }));

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

function mount(initial: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <FileNotesSnackbar />
      </>
    ),
  });
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
  const importRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/import' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute.addChildren([indexRoute]), importRoute]),
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
  return { router };
}

function drag(type: 'dragover' | 'drop', target: Element, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      items: type === 'drop' ? [] : files.map(() => ({ kind: 'file' })),
      files: type === 'drop' ? files : [],
      dropEffect: 'copy',
    },
  });
  target.dispatchEvent(event);
  return event;
}

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
const column = () => document.querySelector<HTMLElement>('aside.sidebar')!;
const hint = () => column().querySelector('.list-drop-hint')?.textContent;

let lib: TestLibrary | null = null;
let stopLibraryQueries: (() => void) | null = null;
let n = 0;

beforeEach(() => {
  n = 0;
  planInactive = false;
  resetFileNotesForTests();
  // Signed in, as the root route has claimed before any of this can happen: a batch
  // begun with nobody claimed waits to be adopted (`file-notes.test.ts`).
  claimFileNotesFor('u1');
  session = { user: { id: 'u1', email: 'someone@example.com' } };
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [] } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
  // A create lands in the library as the real action puts it in the local copy.
  vi.mocked(actions.createNote).mockImplementation(async (input) => {
    const id = `new${++n}`;
    const notebookId = input.notebook === 'Receipts' ? 'nb1' : null;
    lib?.upsert('note', note(id, { title: input.title, notebookId, createdAt: 100 + n, updatedAt: 100 + n }));
    const made: Note = { id, ...input, createdAt: 100 + n, updatedAt: 100 + n, fields: [] };
    return made;
  });
  vi.mocked(actions.uploadFile).mockImplementation(async (_id, file) => ({
    filename: file.name,
    contentType: file.type,
    size: file.size,
    path: `files/${file.name}`,
    indexing: 'server' as const,
  }));
  vi.mocked(actions.saveNote).mockResolvedValue('queued');
  vi.mocked(actions.trashNotes).mockResolvedValue(2);
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

describe('files dropped on the note list', () => {
  it('says what a drop will do, naming the notebook the list shows', async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Alpha' })], notebooks: [{ id: 'nb1', name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] }] });
    mount('/notes?notebook=Receipts');
    await screen.findByRole('heading', { name: 'Receipts' });
    const event = drag('dragover', column(), [pdf('a.pdf'), pdf('b.pdf')]);
    expect(event.defaultPrevented).toBe(true);
    // The sentence is React state set from a DOM listener, so it lands a render later.
    await waitFor(() => expect(hint()).toBe('Drop to add 2 notes to Receipts'));
    expect(column().className).toContain('dropping');
  });

  it('names no place on All notes', async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Alpha' })] });
    mount('/notes');
    await screen.findByText('Alpha');
    drag('dragover', column(), [pdf('a.pdf')]);
    await waitFor(() => expect(hint()).toBe('Drop to add a note'));
  });

  it('makes one note per file in the notebook, then selects them for the bar', async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Alpha' })], notebooks: [{ id: 'nb1', name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] }] });
    mount('/notes?notebook=Receipts');
    await screen.findByRole('heading', { name: 'Receipts' });
    drag('drop', column(), [pdf('Water bill.pdf'), pdf('Gas bill.pdf')]);
    await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(actions.createNote).mock.calls.map((c) => c[0])).toEqual([
      { title: 'Water bill', body: '[Water bill.pdf](<files/Water bill.pdf>)\n', tags: [], notebook: 'Receipts' },
      { title: 'Gas bill', body: '[Gas bill.pdf](<files/Gas bill.pdf>)\n', tags: [], notebook: 'Receipts' },
    ]);
    // The two new rows are the selection, and the bar is up with its actions.
    await screen.findByText('Water bill');
    const bar = await screen.findByRole('toolbar', { name: 'Selected notes' });
    expect(bar.querySelector('.selection-count')?.textContent).toContain('2');
    expect(screen.getByRole('button', { name: 'Move to notebook' })).toBeTruthy();
    // And the card says so, with Undo.
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('2 notes added to Receipts.');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  /* Twelve uploads take a while; a selection put over another notebook's rows would be wrong. */
  it('does not select the notes when the list has moved to another scope meanwhile', async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Alpha' })], notebooks: [{ id: 'nb1', name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] }] });
    const { router } = mount('/notes?notebook=Receipts');
    await screen.findByRole('heading', { name: 'Receipts' });
    let release!: () => void;
    vi.mocked(actions.uploadFile).mockReturnValueOnce(new Promise((r) => (release = () => r({ filename: 'a.pdf', contentType: 'application/pdf', size: 1, path: 'files/a.pdf', indexing: 'server' as const }))));
    drag('drop', column(), [pdf('a.pdf')]);
    await waitFor(() => expect(actions.uploadFile).toHaveBeenCalled());
    await router.navigate({ to: '/notes', search: {} });
    await screen.findByRole('heading', { name: 'All notes' });
    release();
    await screen.findByRole('status');
    await screen.findByText('a');
    expect(screen.queryByRole('toolbar', { name: 'Selected notes' })).toBeNull();
  });

  it('files the notes with the list’s tag, and nowhere, on a tag', async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Alpha', tagIds: ['t1'] })], tags: [{ id: 't1', name: 'urgent' }] });
    mount('/notes?tag=urgent');
    await screen.findByText('Alpha');
    drag('dragover', column(), [pdf('a.pdf')]);
    await waitFor(() => expect(hint()).toBe('Drop to add a note to urgent'));
    drag('drop', column(), [pdf('a.pdf')]);
    await waitFor(() => expect(actions.createNote).toHaveBeenCalledWith({ title: 'a', body: '[a.pdf](files/a.pdf)\n', tags: ['urgent'], notebook: null }));
  });

  /* Reported on every page: nothing else draws a drop's batch, the Import page included. */
  it('keeps the card on the Import page for a batch from a drop', async () => {
    lib = installTestLibrary({ notes: [] });
    const { router } = mount('/notes');
    await screen.findByText('nothing open');
    drag('drop', column(), [pdf('a.pdf')]);
    await screen.findByRole('status');
    await router.navigate({ to: '/settings/import' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/import'));
    expect(screen.getByRole('status').textContent).toContain('1 note added.');
  });

  /* An .enex on the list is meant for the Import page, not for a note; a folder is not a file. */
  it('refuses a drop holding a file that is not a PDF or an image, and says which', async () => {
    lib = installTestLibrary({ notes: [] });
    mount('/notes');
    await screen.findByText('nothing open');
    drag('drop', column(), [pdf('a.pdf'), new File(['<en-export/>'], 'Coupons.enex', { type: 'application/xml' })]);
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Coupons.enex (not a PDF or an image)');
    expect(actions.createNote).not.toHaveBeenCalled();
  });

  it('refuses the drag with the pointer while the plan has ended', async () => {
    planInactive = true;
    lib = installTestLibrary({ notes: [] });
    mount('/notes');
    await screen.findByText('nothing open');
    const event = drag('dragover', column(), [pdf('a.pdf')]);
    expect(event.defaultPrevented).toBe(true);
    expect((event as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('none');
    await new Promise((r) => setTimeout(r, 20));
    expect(hint()).toBeUndefined();
  });

  it('Undo trashes the batch', async () => {
    lib = installTestLibrary({ notes: [] });
    mount('/notes');
    await screen.findByText('nothing open');
    drag('drop', column(), [pdf('a.pdf'), pdf('b.pdf')]);
    const undo = await screen.findByRole('button', { name: 'Undo' });
    undo.click();
    await waitFor(() => expect(actions.trashNotes).toHaveBeenCalledWith(['new1', 'new2']));
  });
});
