import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import type { Note } from '@unbent/shared';
import * as actions from '../store/actions.js';
import { pickImportFile } from '../import-run.js';
import { claimFileNotesFor, resetFileNotesForTests } from '../file-notes.js';
import { Import } from './Import.js';

/**
 * The Import page's picker takes PDFs and images too, any number of them, one note each:
 * the way in on a phone, where nothing can be dragged onto the list. An export is still
 * one file at a time, and a mix is refused in a sentence.
 */

vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  createNote: vi.fn(),
  synced: vi.fn(async () => true),
  uploadFile: vi.fn(),
  saveNote: vi.fn(),
  trashNotes: vi.fn(),
}));
vi.mock('../index-files.js', () => ({ indexUploadedFile: vi.fn() }));
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  listNotebooks: vi.fn(async () => ({ notebooks: [{ id: 'nb1', name: 'Receipts', purpose: null, emoji: null, count: 0 }], unfiled: 0 })),
}));
vi.mock('../use-plan.js', () => ({ usePlan: () => ({ inactive: false }) }));

async function mount() {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/settings/import', component: Import });
  const notes = createRoute({ getParentRoute: () => rootRoute, path: '/notes', component: () => <p>the list</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, notes]),
    history: createMemoryHistory({ initialEntries: ['/settings/import'] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Import' });
  return { router, picker: document.querySelector<HTMLInputElement>('input[type=file]')! };
}

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });

let n = 0;
beforeEach(() => {
  n = 0;
  resetFileNotesForTests();
  // Signed in, as the root route has claimed before any of this can happen: a batch
  // begun with nobody claimed waits to be adopted (`file-notes.test.ts`).
  claimFileNotesFor('u1');
  pickImportFile(null);
  vi.mocked(actions.createNote).mockImplementation(async (input) => {
    const made: Note = { id: `n${++n}`, ...input, createdAt: 1, updatedAt: 1, fields: [] };
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
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the Import page with PDFs and images', () => {
  it('names the format beside the exports', async () => {
    await mount();
    expect(screen.getByText(/one note per file, named after/)).toBeTruthy();
    expect(document.querySelector('input[type=file]')?.getAttribute('accept')).toContain('application/pdf');
  });

  it('takes any number of them, asks where they go, and makes one note each there', async () => {
    const { picker, router } = await mount();
    fireEvent.change(picker, { target: { files: [pdf('Water bill.pdf'), pdf('Gas bill.pdf')] } });
    expect(screen.getByText('2 files · 8 B')).toBeTruthy();
    expect(screen.getByText('One note per file, named after it, with the file attached.')).toBeTruthy();
    // Start import is for an export; here the one button says what it adds.
    expect(screen.queryByRole('button', { name: 'Start import' })).toBeNull();
    // The note's own picker, over the notebooks that exist.
    await screen.findByRole('option', { name: 'Receipts' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Notebook' }), { target: { value: 'Receipts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 notes' }));
    await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(actions.createNote).mock.calls.map((c) => c[0])).toEqual([
      { title: 'Water bill', body: '[Water bill.pdf](<files/Water bill.pdf>)\n', tags: [], notebook: 'Receipts' },
      { title: 'Gas bill', body: '[Gas bill.pdf](<files/Gas bill.pdf>)\n', tags: [], notebook: 'Receipts' },
    ]);
    await screen.findByText('2 notes added to Receipts.');
    // "Show them" is a link to the notebook the notes went to.
    const show = screen.getByRole('link', { name: 'Show them' });
    expect(show.getAttribute('href')).toBe('/notes?notebook=Receipts');
    fireEvent.click(show);
    await waitFor(() => expect(router.state.location.href).toBe('/notes?notebook=Receipts'));
  });

  it('offers Undo beside the result, which trashes the notes', async () => {
    vi.mocked(actions.trashNotes).mockResolvedValue(1);
    const { picker } = await mount();
    fireEvent.change(picker, { target: { files: [pdf('scan.pdf')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await screen.findByText('1 note added.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(actions.trashNotes).toHaveBeenCalledWith(['n1']));
    await waitFor(() => expect(screen.queryByText('1 note added.')).toBeNull());
  });

  it('files them nowhere when no notebook is named', async () => {
    const { picker } = await mount();
    fireEvent.change(picker, { target: { files: [pdf('scan.pdf')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(actions.createNote).toHaveBeenCalledWith({ title: 'scan', body: '[scan.pdf](files/scan.pdf)\n', tags: [], notebook: null }));
    await screen.findByText('1 note added.');
  });

  it('still takes one export, and refuses a mix', async () => {
    const { picker } = await mount();
    fireEvent.change(picker, { target: { files: [new File(['<en-export/>'], 'Coupons.enex')] } });
    expect(screen.getByText(/filed in a notebook called “Coupons”/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start import' })).toBeTruthy();
    fireEvent.change(picker, { target: { files: [new File(['<en-export/>'], 'Coupons.enex'), pdf('scan.pdf')] } });
    expect(screen.getByText('Choose one export at a time, or any number of PDFs and images.')).toBeTruthy();
    expect(screen.queryByText(/Coupons/)).toBeNull();
  });
});
