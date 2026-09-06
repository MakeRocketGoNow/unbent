import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { NotesOverflow } from './NotesOverflow.js';

/**
 * The note list's ⋯ menu.
 *
 * Sort had an icon of its own here, which left Settings unreachable: the topbar carries it
 * behind the avatar and the topbar is hidden over the phone's list. So the shape being
 * pinned is Android's — sort and Settings under one menu — and the part that matters most
 * is that Settings is offered whatever else is going on, including mid-search where sort is
 * not.
 *
 * jsdom has no `showModal`; stubbed as in `Sheet.test.tsx`.
 */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
}

function harness(props: Partial<Parameters<typeof NotesOverflow>[0]> = {}) {
  stubDialog();
  const full = { sort: undefined, order: undefined, showSort: true, ...props };
  const rootRoute = createRootRoute({ component: () => <NotesOverflow {...full} /> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), history };
}

const open = async (findByLabelText: (t: string) => Promise<HTMLElement>) => {
  fireEvent.click(await findByLabelText('More'));
};

/** The sort sheet, typed — `querySelector` hands back an `Element`, which has no `open`. */
const sortSheet = (c: HTMLElement) =>
  c.querySelector<HTMLDialogElement>('dialog[aria-label="Sort notes"]');

describe('NotesOverflow', () => {
  afterEach(cleanup);

  /* Naming the order in the row is Android's choice and the better read: one line says
     what the sort *is*, without a second tap to go and look. */
  it('names the current sort in the row that opens it', async () => {
    const { findByLabelText, findByText } = harness({ sort: 'title', order: 'asc' });
    await open(findByLabelText);
    expect(await findByText('Sort: Title A–Z')).toBeTruthy();
  });

  it('names the default sort when the URL carries none', async () => {
    const { findByLabelText, findByText } = harness();
    await open(findByLabelText);
    expect(await findByText('Sort: Recently updated')).toBeTruthy();
  });

  /*
   * The reason this menu exists. A view with no route to Settings is a worse problem than a
   * sort that costs an extra tap, and search hides the sort but must not hide the way out.
   */
  it('offers Settings even while searching, where sort is not offered', async () => {
    const { findByLabelText, findByText, queryByText } = harness({ showSort: false });
    await open(findByLabelText);
    expect(await findByText('Settings')).toBeTruthy();
    expect(queryByText(/^Sort:/)).toBeNull();
  });

  /* Settings navigates, so it is a link: middle-click and copy keep working. */
  it('draws Settings as a link rather than a button', async () => {
    const { findByLabelText, findByText } = harness();
    await open(findByLabelText);
    expect((await findByText('Settings')).tagName).toBe('A');
  });

  it('opens the orders as a sheet, with the current one marked', async () => {
    const { findByLabelText, findByText, container } = harness({ sort: 'created', order: 'desc' });
    await open(findByLabelText);
    fireEvent.click(await findByText('Sort: Newest first'));
    await waitFor(() =>
      expect(sortSheet(container)?.open).toBe(true),
    );
    const marked = [...container.querySelectorAll('.sort-option.current')].map((e) => e.textContent);
    expect(marked).toEqual(['Newest first']);
  });

  it('writes the chosen order and closes', async () => {
    const { findByLabelText, findByText, container, history } = harness();
    await open(findByLabelText);
    fireEvent.click(await findByText('Sort: Recently updated'));
    fireEvent.click(await findByText('Oldest first'));
    await waitFor(() => {
      expect(history.location.href).toContain('created');
      expect(history.location.href).toContain('asc');
      expect(sortSheet(container)?.open).toBe(false);
    });
  });

  /* The default stays out of the URL, so a plain /notes link is clean. */
  it('writes the default order as absence', async () => {
    const { findByLabelText, findByText, history } = harness({ sort: 'title', order: 'asc' });
    await open(findByLabelText);
    fireEvent.click(await findByText('Sort: Title A–Z'));
    fireEvent.click(await findByText('Recently updated'));
    await waitFor(() => {
      expect(history.location.href).not.toContain('sort');
      expect(history.location.href).not.toContain('order');
    });
  });

  void vi;
});
