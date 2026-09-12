import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
