import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { FieldDef } from '@unbent/shared';
import { NotesSort } from './NotesSort.js';

/**
 * The note list's sort icon.
 *
 * It was a ⋯ menu with Settings in it, and Settings is what these used to pin. Settings
 * lives on the drawer's floor now, so what is left to pin is that the icon says what the
 * order *is* without being opened, and that the sheet behind it writes the choice to the
 * URL the way the desktop's select did before this replaced it there too.
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

function harness(props: Partial<Parameters<typeof NotesSort>[0]> = {}) {
  stubDialog();
  const full = { sort: undefined, order: undefined, ...props };
  const rootRoute = createRootRoute({ component: () => <NotesSort {...full} /> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), history, router };
}

const field = (id: string, name: string, type: FieldDef['type'], position: number): FieldDef =>
  ({ id, notebookId: 'nb', name, type, position }) as FieldDef;
const amount = field('f-amount', 'Amount', 'number', 0);
const due = field('f-due', 'Due', 'date', 1);

/**
 * The URL's search as the router parsed it, to compare whole. Read from the router's own
 * state — the router owns the location, which is what `url-boundary.test.ts` guards.
 */
const params = (router: { state: { location: { search: unknown } } }) => {
  const { search } = router.state.location;
  return search;
};

/** The sort sheet, typed — `querySelector` hands back an `Element`, which has no `open`. */
const sortSheet = (c: HTMLElement) =>
  c.querySelector<HTMLDialogElement>('dialog[aria-label="Sort notes"]');

describe('NotesSort', () => {
  // The sheet reads the breakpoint to decide whether its head drags; jsdom has no
  // matchMedia. Phone width, which is where this surface lives.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /* An order you cannot see is a list arranged in a way you did not ask for, and the icon
     has no room for a caption — so the name carries it. */
  it('names the current sort in the icon', async () => {
    const { findByLabelText } = harness({ sort: 'title', order: 'asc' });
    expect(await findByLabelText('Sort notes, currently Title A–Z')).toBeTruthy();
  });

  it('names the default sort when the URL carries none', async () => {
    const { findByLabelText } = harness();
    expect(await findByLabelText('Sort notes, currently Newest first')).toBeTruthy();
  });

  it('opens the orders as a sheet, with the current one marked', async () => {
    const { findByLabelText, container } = harness({ sort: 'created', order: 'desc' });
    fireEvent.click(await findByLabelText(/^Sort notes, currently/));
    await waitFor(() => expect(sortSheet(container)?.open).toBe(true));
    const marked = [...container.querySelectorAll('.sort-option.current')].map(
      (e) => e.textContent,
    );
    expect(marked).toEqual(['Newest first']);
  });

  it('writes the chosen order and closes', async () => {
    const { findByLabelText, findByText, container, history } = harness();
    fireEvent.click(await findByLabelText(/^Sort notes, currently/));
    fireEvent.click(await findByText('Title A–Z'));
    await waitFor(() => {
      expect(history.location.href).toContain('title');
      expect(history.location.href).toContain('asc');
      expect(sortSheet(container)?.open).toBe(false);
    });
  });

  /* No named order may claim to be current over a list ordered by something else; the
     field's own direction is what is marked. */
  it('names a field sort and marks its direction, not a named order', async () => {
    const { findByLabelText, container } = harness({
      sortField: 'f-amount',
      fields: [amount, due],
      order: 'asc',
    });
    fireEvent.click(await findByLabelText('Sort notes, currently Amount, lowest first'));
    await waitFor(() => expect(sortSheet(container)?.open).toBe(true));
    expect(container.querySelectorAll('.sort-option.current')).toHaveLength(0);
    const marked = [...container.querySelectorAll('.sort-direction.current')].map((e) =>
      e.getAttribute('aria-label'),
    );
    expect(marked).toEqual(['Amount, lowest first']);
  });

  /* The phone has no table, so this sheet is the only way there to sort by a field. */
  it("offers each of the notebook's fields in both directions", async () => {
    const { findByLabelText, findByRole, router, container } = harness({ fields: [amount, due] });
    fireEvent.click(await findByLabelText(/^Sort notes, currently/));
    fireEvent.click(await findByRole('button', { name: 'Due, oldest first' }));
    await waitFor(() => {
      expect(params(router)).toMatchObject({ sortField: 'f-due', order: 'asc' });
      expect(sortSheet(container)?.open).toBe(false);
    });
  });

  /* Descending is the default order, so it stays out of the URL like any other default. */
  it("writes a field sort's default direction as absence", async () => {
    const { findByLabelText, findByRole, router } = harness({ fields: [amount, due] });
    fireEvent.click(await findByLabelText(/^Sort notes, currently/));
    fireEvent.click(await findByRole('button', { name: 'Due, newest first' }));
    await waitFor(() => expect(params(router)).toEqual({ sortField: 'f-due' }));
  });

  it('offers no field section outside a notebook', async () => {
    const { findByLabelText, container } = harness();
    fireEvent.click(await findByLabelText(/^Sort notes, currently/));
    await waitFor(() => expect(sortSheet(container)?.open).toBe(true));
    expect(container.querySelector('.sort-fields')).toBeNull();
  });

  /* Picking a named order is how a field sort is left, so it must clear the field. */
  it('clears the field sort when a named order is chosen', async () => {
    const { findByLabelText, findByText, router } = harness({
      sortField: 'f-amount',
      fields: [amount],
      order: 'asc',
    });
    fireEvent.click(await findByLabelText(/^Sort notes, currently/));
    fireEvent.click(await findByText('Title A–Z'));
    await waitFor(() => expect(params(router)).toEqual({ sort: 'title', order: 'asc' }));
  });

  /* The default stays out of the URL, so a plain /notes link is clean. */
  it('writes the default order as absence', async () => {
    const { findByLabelText, findByText, history } = harness({ sort: 'title', order: 'asc' });
    fireEvent.click(await findByLabelText(/^Sort notes, currently/));
    fireEvent.click(await findByText('Newest first'));
    await waitFor(() => {
      expect(history.location.href).not.toContain('sort');
      expect(history.location.href).not.toContain('order');
    });
  });
});
