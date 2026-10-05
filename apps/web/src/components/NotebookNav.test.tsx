import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { NotebookNav } from './NotebookNav.js';

const TAGS = [
  { name: 'Receipt', count: 40 },
  { name: 'Travel', count: 12 },
  { name: 'Recipe', count: 3 },
];
/** Thirty invented tags, most used first, to run past the cap. */
const MANY_TAGS = Array.from({ length: 30 }, (_, i) => ({ name: `tag-${i}`, count: 30 - i }));

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
    tags: [],
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
    const { findByRole } = harness();
    expect((await findByRole('link', { name: 'All notes' })).className).toContain('current');

    cleanup();
    const tagged = harness({ selectedTags: ['Receipt'] });
    expect((await tagged.findByRole('link', { name: 'All notes' })).className).not.toContain(
      'current',
    );
  });

  /*
   * Beside the trash or settings the URL still names a notebook, and lighting its row
   * there would say the trash is in it. The destination lights instead — by the screen,
   * never by the router's own `active`, which is the phone drawer's test to keep.
   */
  it('marks the destination it stands beside, and no place, off the notes', async () => {
    const { findByRole } = harness({ place: 'trash', notebook: 'Coupons' });
    const trash = await findByRole('link', { name: /^Trash/ });
    expect(trash.className).toContain('current');
    expect(trash.getAttribute('aria-current')).toBe('page');
    expect((await findByRole('link', { name: /^Coupons/ })).className).not.toContain('current');
    expect((await findByRole('link', { name: 'All notes' })).className).not.toContain('current');
  });

  /* A strip of icons keeps the words as tooltips, and keeps them in the DOM as names. */
  it('adds tooltips to the rows a strip keeps, without losing their names', async () => {
    const { findByRole } = harness({ labelsHidden: true });
    const trash = await findByRole('link', { name: /^Trash/ });
    expect(trash.getAttribute('title')).toBe('Trash');
    expect((await findByRole('link', { name: 'All notes' })).getAttribute('title')).toBe('All notes');
    // Notebook rows are hidden by the stylesheet in a strip, so they only ever carry
    // their own name, which is what a truncated label needs anyway.
    expect((await findByRole('link', { name: /^Coupons/ })).getAttribute('title')).toBe('Coupons');
  });

  it('marks the notebook you are in', async () => {
    const { findByText } = harness({ notebook: 'Coupons' });
    const row = await findByText('Coupons');
    expect(row.closest('.drawer-item')?.className).toContain('current');
    expect(row.closest('.drawer-item')?.getAttribute('aria-current')).toBe('true');
  });

  it('draws a notebook with an emoji as that emoji, and one without as the book', async () => {
    const { findByText } = harness({
      notebooks: {
        data: {
          notebooks: [
            { id: '1', name: 'Coupons', count: 5, emoji: '🎟️' },
            { id: '2', name: 'Podcast Bookmarks', count: 3, emoji: null },
          ],
          unfiled: 0,
        },
      },
    });
    const withEmoji = (await findByText('Coupons')).closest('.drawer-item')!;
    expect(withEmoji.querySelector('.notebook-emoji')?.textContent).toBe('🎟️');
    expect(withEmoji.querySelector('svg')).toBeNull();

    const without = (await findByText('Podcast Bookmarks')).closest('.drawer-item')!;
    expect(without.querySelector('.notebook-emoji')).toBeNull();
    expect(without.querySelector('svg')).toBeTruthy();
  });

  /*
   * The rule that makes this navigation rather than a filter: tags cross notebook
   * boundaries, so carrying one into a new notebook routinely yields an empty list with no
   * visible cause.
   */
  it('clears the tags when the scope changes, and keeps the dates', async () => {
    localStorage.clear();
    const { findByText, history } = harness({ notebook: undefined, selectedTags: ['Receipt'] });
    await history.push('/notes?from=2024-01-01&tag=Receipt');
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => {
      expect(history.location.href).toContain('Coupons');
      expect(history.location.href).toContain('from=2024-01-01');
      expect(history.location.href).not.toContain('Receipt');
    });
  });

  /*
   * Each place opens in the order it was last left in: the order that suited the place
   * being left says nothing about the one being entered.
   */
  it('opens a notebook in its own remembered order, not the one being left', async () => {
    localStorage.clear();
    localStorage.setItem('unbent.notebookSorts', JSON.stringify({ Coupons: { sort: 'created' } }));
    const { findByText, history } = harness({ notebook: undefined });
    await history.push('/notes?sort=title&order=asc');
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => {
      const href = history.location.href;
      expect(href).toContain('Coupons');
      expect(href).toContain('sort=created');
      expect(href).not.toContain('title');
      expect(href).not.toContain('order');
    });
  });

  it('opens a notebook with nothing remembered in the default order', async () => {
    localStorage.clear();
    const { findByText, history } = harness({ notebook: undefined });
    await history.push('/notes?sort=title&order=asc');
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => {
      expect(history.location.href).toContain('Coupons');
      expect(history.location.href).not.toContain('sort');
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
    const { findByRole } = harness();
    expect((await findByRole('link', { name: /^Trash/ })).tagName).toBe('A');
    expect((await findByRole('link', { name: 'Settings' })).tagName).toBe('A');
    expect((await findByRole('link', { name: 'New notebook' })).tagName).toBe('A');
  });

  it('opens the chooser of templates from New notebook, not just the notebooks page', async () => {
    const { findByRole } = harness();
    expect((await findByRole('link', { name: 'New notebook' })).getAttribute('href')).toBe(
      '/settings/notebooks?new=1',
    );
  });

  describe('tags', () => {
    beforeEach(() => localStorage.clear());

    it('has no section when there are no tags', async () => {
      const { findByRole, queryByRole } = harness({ tags: [] });
      await findByRole('link', { name: 'All notes' });
      expect(queryByRole('button', { name: 'Tags' })).toBeNull();
    });

    /* Closed to begin with, and remembered: someone who works by tag opens it once. */
    it('starts closed, and remembers being opened', async () => {
      const { findByRole, queryByRole } = harness({ tags: TAGS });
      const head = await findByRole('button', { name: 'Tags' });
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(queryByRole('link', { name: /^Receipt/ })).toBeNull();
      fireEvent.click(head);
      await findByRole('link', { name: /^Receipt/ });
      expect(localStorage.getItem('unbent.navTagsOpen')).toBe('true');
    });

    /*
     * A tag is a place across every notebook: the notebook goes, and with it the field
     * filter that belongs to it, and the order is the one All notes remembers.
     */
    it('goes to the tag across all notebooks, in the order All notes remembers', async () => {
      localStorage.setItem('unbent.navTagsOpen', 'true');
      localStorage.setItem('unbent.notebookSorts', JSON.stringify({ '': { sort: 'title' } }));
      const { findByRole, history } = harness({ tags: TAGS, notebook: 'Coupons' });
      await history.push('/notes?notebook=Coupons&sort=created&field=abc:set');
      fireEvent.click(await findByRole('link', { name: /^Receipt/ }));
      await waitFor(() => {
        const href = history.location.href;
        expect(href).toContain('Receipt');
        expect(href).toContain('sort=title');
        expect(href).not.toContain('Coupons');
        expect(href).not.toContain('field');
      });
    });

    it('marks the tag only when it is the whole scope', async () => {
      localStorage.setItem('unbent.navTagsOpen', 'true');
      const alone = harness({ tags: TAGS, selectedTags: ['Receipt'] });
      expect((await alone.findByRole('link', { name: /^Receipt/ })).className).toContain('current');
      cleanup();
      const withNotebook = harness({ tags: TAGS, selectedTags: ['Receipt'], notebook: 'Coupons' });
      expect((await withNotebook.findByRole('link', { name: /^Receipt/ })).className).not.toContain('current');
      cleanup();
      const two = harness({ tags: TAGS, selectedTags: ['Receipt', 'Travel'] });
      expect((await two.findByRole('link', { name: /^Receipt/ })).className).not.toContain('current');
    });

    /* Hundreds of tags is normal for an imported archive; the well-used ones are the
       places, and the rest are one row away. */
    it('lists the most used first, capped, with the rest one row away', async () => {
      localStorage.setItem('unbent.navTagsOpen', 'true');
      const { findByRole, container } = harness({ tags: MANY_TAGS });
      const more = await findByRole('button', { name: 'Show all 30 tags' });
      expect(container.querySelectorAll('.drawer-tags .drawer-item')).toHaveLength(26);
      fireEvent.click(more);
      await waitFor(() =>
        expect(container.querySelectorAll('.drawer-tags .drawer-item')).toHaveLength(30),
      );
    });

    it('keeps the current tag on screen past the cap', async () => {
      localStorage.setItem('unbent.navTagsOpen', 'true');
      const { findByRole } = harness({ tags: MANY_TAGS, selectedTags: ['tag-28'] });
      expect((await findByRole('link', { name: /^tag-28/ })).className).toContain('current');
    });

    it('offers the way to edit the tags beside their section head', async () => {
      const { findAllByText } = harness({ tags: TAGS });
      const edits = await findAllByText('Edit');
      expect(edits.map((e) => e.getAttribute('href'))).toEqual(['/settings/notebooks', '/settings/tags']);
    });
  });

  /* The rows are places to go, so the way to change them lives outside the rows. */
  it('offers the way to edit the notebooks beside their section head', async () => {
    const { findByText } = harness({ tags: [] });
    const edit = await findByText('Edit');
    expect(edit.tagName).toBe('A');
    expect(edit.getAttribute('href')).toBe('/settings/notebooks');
  });
});
