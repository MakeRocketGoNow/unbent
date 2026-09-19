import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import type { NoteSummary } from '@unbent/shared';
import { NoteListItem } from './NoteListItem.js';

const note: NoteSummary = {
  id: 'n1',
  title: 'Lunch',
  createdAt: 0,
  updatedAt: 0,
  tags: ['food'],
  notebook: 'Receipts',
};

function mount(overrides: Partial<NoteSummary> = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <ul>
        <NoteListItem note={{ ...note, ...overrides }} to="/notes/$noteId" />
      </ul>
    ),
  });
  const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([noteRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

afterEach(cleanup);

describe('NoteListItem', () => {
  it('names the field values on one line, readably, above the tags', async () => {
    mount({
      fields: [
        { fieldId: 'a', name: 'Merchant', type: 'text', value: 'Acme', notebookId: 'nb', notebook: 'Receipts' },
        { fieldId: 'b', name: 'Amount', type: 'number', value: 1234.5, notebookId: 'nb', notebook: 'Receipts' },
        { fieldId: 'c', name: 'Paid', type: 'checkbox', value: true, notebookId: 'nb', notebook: 'Receipts' },
      ],
    });
    const line = await screen.findByText(`Merchant: Acme · Amount: ${(1234.5).toLocaleString()} · Paid: Yes`);
    expect(line.className).toBe('note-fields-line');
    expect(line.nextElementSibling?.className).toBe('note-tags');
  });

  it('draws no line for a note without values', async () => {
    mount();
    await screen.findByText('Lunch');
    expect(document.querySelector('.note-fields-line')).toBeNull();
  });

  it('shows the first file by name with a count of the rest, under the excerpt', async () => {
    mount({
      excerpt: 'Used credit card.',
      attachments: [
        { filename: 'Sale Confirmation.pdf', contentType: 'application/pdf' },
        { filename: 'front.jpg', contentType: 'image/jpeg' },
        { filename: 'back.jpg', contentType: 'image/jpeg' },
      ],
    });
    const name = await screen.findByText('Sale Confirmation.pdf');
    const line = name.parentElement!;
    expect(line.className).toBe('note-files');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('+2').className).toBe('note-files-more');
    expect(line.previousElementSibling?.className).toBe('note-excerpt');
    // Every name is there for a hover, since the row shows only the first.
    expect(line.getAttribute('title')).toBe('Sale Confirmation.pdf\nfront.jpg\nback.jpg');
  });

  it('shows one file without a count', async () => {
    mount({ attachments: [{ filename: 'scan.png', contentType: 'image/png' }] });
    await screen.findByText('scan.png');
    expect(document.querySelector('.note-files-more')).toBeNull();
  });

  it('draws no files line for a note without files', async () => {
    mount();
    await screen.findByText('Lunch');
    expect(document.querySelector('.note-files')).toBeNull();
  });
});

/*
 * The mark the transition grows from.
 *
 * The browser snapshots the page before the URL changes, so the entry has to say it is
 * the one opening, in the click itself. Only one entry may say so at a time: two elements
 * with one `view-transition-name` make the browser skip the transition.
 */
it('marks the tapped entry as opening, and only that one, when transitions are on', async () => {
  const other: NoteSummary = { ...note, id: 'n2', title: 'Dinner' };
  const rootRoute = createRootRoute({
    component: () => (
      <ul className="note-list">
        <NoteListItem note={note} to="/notes/$noteId" transition />
        <NoteListItem note={other} to="/notes/$noteId" transition />
      </ul>
    ),
  });
  const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([noteRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { findByText, getByText } = render(<RouterProvider router={router as any} />);

  fireEvent.click(await findByText('Lunch'));
  expect(getByText('Lunch').closest('a')?.hasAttribute('data-opening')).toBe(true);
  expect(getByText('Dinner').closest('a')?.hasAttribute('data-opening')).toBe(false);

  fireEvent.click(getByText('Dinner'));
  expect(getByText('Lunch').closest('a')?.hasAttribute('data-opening')).toBe(false);
  expect(getByText('Dinner').closest('a')?.hasAttribute('data-opening')).toBe(true);
});

it('leaves entries unmarked where there is no transition to grow from', async () => {
  const { findByText, getByText } = mount();
  fireEvent.click(await findByText('Lunch'));
  expect(getByText('Lunch').closest('a')?.hasAttribute('data-opening')).toBe(false);
});

/*
 * Selecting several. The rules a screenshot cannot check: which clicks pick and which
 * open, that Space picks, and that the checkbox is only there while the list is
 * selecting.
 */
describe('a selectable entry', () => {
  function mountSelectable(selection: { selected?: boolean; active?: boolean } = {}) {
    const onPick = vi.fn();
    const rootRoute = createRootRoute({
      component: () => (
        <ul className="note-list">
          <NoteListItem
            note={note}
            to="/notes/$noteId"
            selection={{ selected: false, active: false, ...selection, onPick }}
          />
        </ul>
      ),
    });
    const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId' });
    const router = createRouter({
      routeTree: rootRoute.addChildren([noteRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<RouterProvider router={router as any} />);
    return { onPick, router };
  }

  it('picks on a Cmd- or Ctrl-click instead of opening', async () => {
    const { onPick, router } = mountSelectable();
    const link = (await screen.findByText('Lunch')).closest('a')!;
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenLastCalledWith({ range: false });
    expect(router.state.location.pathname).toBe('/');
  });

  it('picks a range on a Shift-click', async () => {
    const { onPick } = mountSelectable();
    fireEvent.click((await screen.findByText('Lunch')).closest('a')!, { shiftKey: true });
    expect(onPick).toHaveBeenCalledWith({ range: true });
  });

  it('picks on Space, which would otherwise scroll', async () => {
    const { onPick } = mountSelectable();
    const link = (await screen.findByText('Lunch')).closest('a')!;
    fireEvent.keyDown(link, { key: ' ' });
    expect(onPick).toHaveBeenCalledWith({ range: false });
    fireEvent.keyDown(link, { key: ' ', shiftKey: true });
    expect(onPick).toHaveBeenLastCalledWith({ range: true });
  });

  it('still opens on a plain click', async () => {
    const { onPick, router } = mountSelectable({ active: true });
    fireEvent.click((await screen.findByText('Lunch')).closest('a')!);
    expect(onPick).not.toHaveBeenCalled();
    await waitFor(() => expect(router.state.location.pathname).toBe('/notes/n1'));
  });

  it('shows a checkbox only while the list is selecting, and rings a selected row', async () => {
    mountSelectable();
    await screen.findByText('Lunch');
    expect(screen.queryByRole('checkbox')).toBeNull();
    cleanup();

    const { onPick } = mountSelectable({ active: true, selected: true });
    const box = (await screen.findByRole('checkbox', { name: 'Select Lunch' })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText('Lunch').closest('a')?.classList.contains('selected')).toBe(true);
    fireEvent.click(box, { shiftKey: true });
    expect(onPick).toHaveBeenCalledWith({ range: true });
  });
});
