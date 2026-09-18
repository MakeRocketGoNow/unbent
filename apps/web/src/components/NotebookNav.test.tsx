import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { NotebookNav } from './NotebookNav.js';

/**
 * The rows of places, wherever they are drawn.
 *
 * This is navigation, and the thing that makes it navigation rather than a filter list is
 * the rule it shares with the notebook picker: choosing a scope clears the tags, because
 * tags cross notebook boundaries and carrying one across lands on an empty list with
 * nothing on screen to explain it. That, and which row is marked as where you are, are
 * what these pin. The surface around the rows — a phone's drawer, a desktop's rail — has
 * tests of its own.
 */
const NOTEBOOKS = {
  data: {
    notebooks: [
      { id: '1', name: 'Coupons', count: 5 },
      { id: '2', name: 'Podcast Bookmarks', count: 3 },
    ],
    unfiled: 4,
  },
};

function harness(props: Partial<Parameters<typeof NotebookNav>[0]> = {}) {
  const full = {
    notebook: undefined,
    selectedTags: [],
    notebooks: NOTEBOOKS,
    trashed: 1,
    ...props,
  };
  const rootRoute = createRootRoute({ component: () => <NotebookNav {...full} /> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), history };
}

const rows = (c: HTMLElement) =>
  [...c.querySelectorAll('.drawer-item')].map((e) => e.textContent);

describe('NotebookNav', () => {
  afterEach(cleanup);

  /* Keep's order: the places, the way to make another, then on the floor the two
     destinations that are not places. */
  it('lists the places notes live, then the destinations', async () => {
    const { container, findByText } = harness();
    await findByText('All notes');
    expect(rows(container)).toEqual([
      'All notes',
      'Inbox4',
      'Coupons5',
      'Podcast Bookmarks3',
      'New notebook',
      'Trash1',
      'Settings',
    ]);
  });

  /* All notes is the unnarrowed list, not merely "no notebook" — a tag is still a
     narrowing, so the row must not claim to be where you are while one is applied. */
  it('marks All notes only when nothing at all is narrowing the list', async () => {
    const { findByText } = harness();
    expect((await findByText('All notes')).className).toContain('current');

    cleanup();
    const tagged = harness({ selectedTags: ['Receipt'] });
    expect((await tagged.findByText('All notes')).className).not.toContain('current');
  });

  it('marks the notebook you are in', async () => {
    const { findByText } = harness({ notebook: 'Coupons' });
    const row = await findByText('Coupons');
    expect(row.closest('.drawer-item')?.className).toContain('current');
    expect(row.closest('.drawer-item')?.getAttribute('aria-current')).toBe('true');
  });

  /*
   * The rule that makes this navigation rather than a filter: tags cross notebook
   * boundaries, so carrying one into a new notebook routinely yields an empty list with no
   * visible cause.
   */
  it('clears the tags when the scope changes, and keeps how you are looking', async () => {
    const { findByText, history } = harness({ notebook: undefined, selectedTags: ['Receipt'] });
    // Arrive with a sort already set, to prove it survives.
    await history.push('/notes?sort=title&tag=Receipt');
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => {
      expect(history.location.href).toContain('Coupons');
      expect(history.location.href).toContain('sort=title');
      expect(history.location.href).not.toContain('Receipt');
    });
  });

  it('reports a scope pick, so a drawer can close behind it', async () => {
    const onNavigate = vi.fn();
    const { findByText } = harness({ onNavigate });
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
  });

  it('sends All notes back to the whole list', async () => {
    const { findByText, history } = harness({ notebook: 'Coupons' });
    fireEvent.click(await findByText('All notes'));
    await waitFor(() => expect(history.location.href).not.toContain('Coupons'));
  });

  /* Offered only when there is something in it: otherwise it leads to a guaranteed empty
     list. It stays while it is the active scope, so the rows never fail to say where you
     are. */
  it('offers Inbox only when it holds something or is where you are', async () => {
    const empty = { data: { notebooks: NOTEBOOKS.data.notebooks, unfiled: 0 } };
    const { container, findByText } = harness({ notebooks: empty });
    await findByText('All notes');
    expect(rows(container)).not.toContain('Inbox0');

    cleanup();
    const inIt = harness({ notebooks: empty, notebook: UNFILED });
    expect((await inIt.findByText('Inbox')).closest('.drawer-item')?.className).toContain(
      'current',
    );
  });

  it('keeps the trash count off the row when the trash is empty', async () => {
    const { container, findByText } = harness({ trashed: 0 });
    await findByText('All notes');
    expect(rows(container)).toContain('Trash');
  });

  /* Trash, Settings and New notebook navigate, so they are links: middle-click and copy
     keep working, which a button would lose. */
  it('draws the destinations as links rather than buttons', async () => {
    const { findByText } = harness();
    expect((await findByText('Trash')).tagName).toBe('A');
    expect((await findByText('Settings')).tagName).toBe('A');
    expect((await findByText('New notebook')).tagName).toBe('A');
  });

  /* The rows are places to go, so the way to change them lives outside the rows. */
  it('offers the way to edit the notebooks beside their section head', async () => {
    const { findByText } = harness();
    const edit = await findByText('Edit');
    expect(edit.tagName).toBe('A');
    expect(edit.getAttribute('href')).toBe('/settings/notebooks');
  });
});
