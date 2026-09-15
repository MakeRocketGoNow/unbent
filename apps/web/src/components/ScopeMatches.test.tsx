import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ScopeMatches } from './ScopeMatches.js';

/**
 * Tags and notebooks offered at the top of a search.
 *
 * What is pinned: that a name containing the term is offered and one that does not is not,
 * that what is already applied is left out, that the offer is capped, and that a pick
 * writes the filter to the URL and drops the query — the URL being where the filters live,
 * so it is the only place a pick can be observed. Read as `href` for the reason
 * `ActiveFilters.test.tsx` gives.
 */
const TAGS = [
  { name: 'Receipt', count: 9 },
  { name: 'Recipe', count: 4 },
  { name: 'Rec Center', count: 3 },
  { name: 'Wreck', count: 2 },
  { name: 'Record', count: 2 },
  { name: 'Recall', count: 1 },
  { name: 'Recliner', count: 1 },
  { name: 'Ash', count: 1 },
];
const NOTEBOOKS = {
  notebooks: [
    { id: '1', name: 'Recipes', count: 5 },
    { id: '2', name: 'Coupons', count: 3 },
  ],
  unfiled: 0,
};

type Props = Parameters<typeof ScopeMatches>[0];

function harness(props: Partial<Props> = {}, initial = '/notes?q=rec') {
  const all: Props = {
    query: 'rec',
    tags: TAGS,
    notebooks: NOTEBOOKS,
    selectedTags: [],
    notebook: undefined,
    onPick: () => {},
    ...props,
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ul>
        <ScopeMatches {...all} />
      </ul>
    ),
  });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rendered = render(<RouterProvider router={router as any} />);
  return { ...rendered, history };
}

const names = (c: HTMLElement) =>
  [...c.querySelectorAll('.scope-match-name')].map((e) => e.textContent);

describe('ScopeMatches', () => {
  afterEach(cleanup);

  it('offers the tags and notebooks whose names contain the term, tags first', async () => {
    const { container, findByLabelText } = harness({ query: 'ash' });
    await findByLabelText('Filter by tag: Ash');
    expect(names(container)).toEqual(['Ash']);
  });

  /* The word over the group is what keeps a tag row among note rows from reading as a
     note with something wrong with it. */
  it('captions the group', async () => {
    const { container, findByLabelText } = harness({ query: 'ash' });
    await findByLabelText('Filter by tag: Ash');
    expect(container.querySelector('.list-caption')?.textContent).toBe('Tags and notebooks');
  });

  it('matches anywhere in the name, not only at the start', async () => {
    const { findByLabelText } = harness({ query: 'reck', tags: [{ name: 'Wreck', count: 2 }] });
    await findByLabelText('Filter by tag: Wreck');
  });

  it('caps what it offers so it stays above the notes', async () => {
    const { container, findByLabelText } = harness();
    await findByLabelText('Filter by tag: Receipt');
    // Seven tags contain "rec"; five are offered, in the order given (by count).
    const tagRows = [...container.querySelectorAll('[aria-label^="Filter by tag"]')];
    expect(tagRows.length).toBe(5);
    expect(names(container).slice(0, 2)).toEqual(['Receipt', 'Recipe']);
    // And the one notebook, after them.
    expect(names(container).at(-1)).toBe('Recipes');
  });

  it('leaves out what is already applied', async () => {
    const { container, findByLabelText } = harness({
      query: 'recip',
      selectedTags: ['Recipe'],
      notebook: 'Recipes',
    });
    // Neither the selected tag nor the current notebook is offered again.
    await waitFor(() => expect(container.querySelector('ul')).toBeTruthy());
    expect(names(container)).toEqual([]);
    // With the notebook not current, it is.
    cleanup();
    const second = harness({ query: 'recip', selectedTags: ['Recipe'] });
    await second.findByLabelText('Show notebook: Recipes');
    expect(names(second.container)).toEqual(['Recipes']);
    void findByLabelText;
  });

  it('renders nothing for an empty term or with nothing matching', async () => {
    const empty = harness({ query: '  ' });
    await waitFor(() => expect(empty.container.querySelector('ul')).toBeTruthy());
    expect(empty.container.querySelectorAll('li').length).toBe(0);
    cleanup();
    const none = harness({ query: 'zzz' });
    await waitFor(() => expect(none.container.querySelector('ul')).toBeTruthy());
    expect(none.container.querySelectorAll('li').length).toBe(0);
  });

  /* Picking a tag adds it to the scope — two selected narrows to both — and drops the
     query: having found the thing, there is nothing left to search for. */
  it('adds a picked tag to the filter and clears the search', async () => {
    const onPick = vi.fn();
    const { findByLabelText, history } = harness({ selectedTags: ['Ash'], onPick });
    fireEvent.click(await findByLabelText('Filter by tag: Receipt'));
    await waitFor(() => expect(history.location.href).toContain('tag='));
    expect(decodeURIComponent(history.location.href)).toContain('["Ash","Receipt"]');
    expect(history.location.href).not.toContain('q=');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  /* A notebook is a place you go, so picking one replaces the scope rather than adding
     to it, and it drops the tags the way the select and the drawer do. */
  it('moves to a picked notebook, clearing the tags with it', async () => {
    const { findByLabelText, history } = harness(
      { selectedTags: ['Ash'] },
      '/notes?q=rec&tag=%5B%22Ash%22%5D',
    );
    fireEvent.click(await findByLabelText('Show notebook: Recipes'));
    await waitFor(() => expect(history.location.href).toContain('notebook=Recipes'));
    expect(history.location.href).not.toContain('tag=');
    expect(history.location.href).not.toContain('q=');
  });
});
