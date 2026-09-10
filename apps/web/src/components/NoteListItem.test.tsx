import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
