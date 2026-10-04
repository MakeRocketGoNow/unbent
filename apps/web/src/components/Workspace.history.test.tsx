import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import type { Note, NoteRevision } from '@unbent/shared';
import * as api from '../notes-api.js';
import { NoteChangedError } from '../notes-api.js';
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  updateNote: vi.fn(),
  listRevisions: vi.fn(),
  getRevision: vi.fn(),
  restoreRevision: vi.fn(),
}));

/**
 * An earlier version put back from the note's ⋯ menu (MAK-119).
 *
 * What the workspace owes a restore: whatever is on screen reaches the server first, so
 * the server can keep it; the note on screen becomes the restored one without the
 * autosave taking it for an edit; and the snackbar's Undo puts back the copy the restore
 * itself kept, and nothing else.
 */
const note: Note = {
  id: 'n1',
  title: 'Minutes',
  body: 'TODO',
  tags: ['work'],
  notebook: null,
  createdAt: 0,
  updatedAt: 100,
  fields: [],
};

const earlier: NoteRevision = { id: 4, title: 'Minutes', body: 'Agreed: ship on Friday.', size: 23, createdAt: Date.now() - 60_000, cause: 'assistant' };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [], autofill: false });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 1 });

  const rootRoute = createRootRoute({ component: () => <Workspace noteId={note.id} /> });
  const notesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return client;
}

const title = () => screen.findByPlaceholderText<HTMLInputElement>('Untitled');

async function openVersion() {
  fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  fireEvent.click(await screen.findByRole('button', { name: /23 characters$/ }));
  const restore = screen.getByRole<HTMLButtonElement>('button', { name: 'Restore this version' });
  await waitFor(() => expect(restore.disabled).toBe(false));
  return restore;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.mocked(api.listRevisions).mockResolvedValue([earlier]);
  vi.mocked(api.getRevision).mockResolvedValue(earlier);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('restoring a version from History', () => {
  it('puts the version on screen, closes the sheet, and saves nothing of its own', async () => {
    vi.mocked(api.restoreRevision).mockResolvedValue({ note: { ...note, title: 'Minutes (final)', body: earlier.body, updatedAt: 200 }, kept: 5 });
    const client = mount();
    fireEvent.click(await openVersion());

    await waitFor(async () => expect((await title()).value).toBe('Minutes (final)'));
    expect(api.restoreRevision).toHaveBeenCalledWith('n1', 4, {});
    expect(client.getQueryData<Note>(keys.note('n1'))).toMatchObject({ body: earlier.body, updatedAt: 200 });
    expect(screen.getByRole('status').textContent).toContain('Restored the version from today,');
    await waitFor(() => expect(document.querySelector<HTMLDialogElement>('dialog.history-sheet')!.open).toBe(false));

    // The restored note is the autosave's new baseline, not an edit to send.
    await new Promise((r) => setTimeout(r, 1000));
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('saves what was typed before asking for the restore, so the server can keep it', async () => {
    vi.mocked(api.updateNote).mockImplementation(async (_id, patch) => ({ ...note, ...patch, updatedAt: 150 }) as Note);
    vi.mocked(api.restoreRevision).mockResolvedValue({ note: { ...note, body: earlier.body, updatedAt: 200 }, kept: 5 });
    mount();
    fireEvent.change(await title(), { target: { value: 'Minutes, typed a second ago' } });
    fireEvent.click(await openVersion());

    await waitFor(() => expect(api.restoreRevision).toHaveBeenCalled());
    expect(vi.mocked(api.updateNote).mock.calls[0]?.[1]).toMatchObject({ title: 'Minutes, typed a second ago' });
    expect(vi.mocked(api.updateNote).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.restoreRevision).mock.invocationCallOrder[0]!,
    );
  });

  it('restores nothing when what was typed cannot be saved, and says so in the sheet', async () => {
    vi.mocked(api.updateNote).mockRejectedValue(new Error('500 Internal Server Error'));
    mount();
    fireEvent.change(await title(), { target: { value: 'Typed, and unsaveable' } });
    fireEvent.click(await openVersion());

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be saved, so nothing was restored/);
    expect(api.restoreRevision).not.toHaveBeenCalled();
    expect((await title()).value).toBe('Typed, and unsaveable');
  });

  it('undoes a restore with the copy the restore kept, if the note is as the restore left it', async () => {
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: { ...note, body: earlier.body, updatedAt: 200 }, kept: 5 });
    mount();
    fireEvent.click(await openVersion());
    const undo = await screen.findByRole('button', { name: 'Undo' });

    // The server's list now leads with what the restore replaced, taken at the note's new date.
    vi.mocked(api.listRevisions).mockResolvedValueOnce([{ id: 5, title: 'Minutes', size: 4, createdAt: 200, cause: 'restore' }, earlier]);
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: { ...note, title: 'Minutes, as it was', updatedAt: 300 }, kept: 5 });
    fireEvent.click(undo);

    await waitFor(() => expect(api.restoreRevision).toHaveBeenLastCalledWith('n1', 5, { ifUpdatedAt: 200 }));
    await waitFor(async () => expect((await title()).value).toBe('Minutes, as it was'));
  });

  it('does not undo into a version the restore did not make', async () => {
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: { ...note, body: earlier.body, updatedAt: 200 }, kept: 5 });
    mount();
    fireEvent.click(await openVersion());
    const undo = await screen.findByRole('button', { name: 'Undo' });

    // An earlier restore's copy, and an assistant's: neither was taken at this restore's date.
    vi.mocked(api.listRevisions).mockResolvedValueOnce([
      { id: 6, title: 'Minutes', size: 9, createdAt: 250, cause: 'assistant' },
      { id: 3, title: 'Minutes', size: 9, createdAt: 90, cause: 'restore' },
    ]);
    fireEvent.click(undo);

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/open History to choose a version/));
    expect(api.restoreRevision).toHaveBeenCalledTimes(1);
  });

  it('saves what was typed after the restore before undoing, and leaves it when the server refuses the undo', async () => {
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: { ...note, body: earlier.body, updatedAt: 200 }, kept: 5 });
    mount();
    fireEvent.click(await openVersion());
    const undo = await screen.findByRole('button', { name: 'Undo' });

    // Typed while the snackbar is up. The save moves the note's date past the restore's.
    vi.mocked(api.updateNote).mockImplementation(async (_id, patch) => ({ ...note, body: earlier.body, ...patch, updatedAt: 250 }) as Note);
    fireEvent.change(await title(), { target: { value: 'Minutes, typed since the restore' } });
    vi.mocked(api.listRevisions).mockResolvedValueOnce([{ id: 5, title: 'Minutes', size: 4, createdAt: 200, cause: 'restore' }]);
    vi.mocked(api.restoreRevision).mockRejectedValueOnce(new NoteChangedError({ ...note, title: 'Minutes, typed since the restore', updatedAt: 250 }));
    fireEvent.click(undo);

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/open History to choose a version/));
    expect(vi.mocked(api.updateNote).mock.calls[0]?.[1]).toMatchObject({ title: 'Minutes, typed since the restore' });
    expect(vi.mocked(api.updateNote).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.restoreRevision).mock.invocationCallOrder[1]!,
    );
    expect((await title()).value).toBe('Minutes, typed since the restore');
  });

  it('leaves on screen what is typed while the undo is on its way', async () => {
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note: { ...note, body: earlier.body, updatedAt: 200 }, kept: 5 });
    mount();
    fireEvent.click(await openVersion());
    const undo = await screen.findByRole('button', { name: 'Undo' });

    vi.mocked(api.listRevisions).mockResolvedValueOnce([{ id: 5, title: 'Minutes', size: 4, createdAt: 200, cause: 'restore' }]);
    let land: (r: { note: Note; kept: number | null }) => void = () => {};
    vi.mocked(api.restoreRevision).mockReturnValueOnce(new Promise((r) => (land = r)));
    // The save of what is typed below is made against the restore's copy, and refused.
    vi.mocked(api.updateNote).mockRejectedValue(new NoteChangedError({ ...note, title: 'Minutes, as it was', updatedAt: 300 }));
    fireEvent.click(undo);
    await waitFor(() => expect(api.restoreRevision).toHaveBeenCalledTimes(2));

    fireEvent.change(await title(), { target: { value: 'Minutes, typed mid-undo' } });
    land({ note: { ...note, title: 'Minutes, as it was', updatedAt: 300 }, kept: 7 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await title()).value).toBe('Minutes, typed mid-undo');
    // And it is put to the person rather than dropped: the save names the old copy.
    await waitFor(() => expect(vi.mocked(api.updateNote).mock.calls.at(-1)?.[1]).toMatchObject({ title: 'Minutes, typed mid-undo', ifUpdatedAt: 200 }), { timeout: 3000 });
    expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain('changed on another device');
  });

  it('says so, and offers no Undo, when the version is what the note already says', async () => {
    vi.mocked(api.restoreRevision).mockResolvedValueOnce({ note, kept: null });
    const client = mount();
    fireEvent.click(await openVersion());

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('That version is what the note already says.'));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    await waitFor(() => expect(document.querySelector<HTMLDialogElement>('dialog.history-sheet')!.open).toBe(false));
    expect(client.getQueryData<Note>(keys.note('n1'))).toEqual(note);
  });
});
