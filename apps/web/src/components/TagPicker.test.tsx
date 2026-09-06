import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { TagPicker } from './TagPicker.js';

/**
 * Choosing tags on an archive that has hundreds of them.
 *
 * The picker replaced a wrapped field of pills that could not survive 326 tags, so what
 * these pin is the machinery that makes a long list usable: the match, the order, and the
 * fact that the selection leaves the list. Picking is asserted on the URL rather than a
 * parsed search object — the filters live there, and `url-boundary.test.ts` greps for the
 * other spelling.
 */
const TAGS = [
  { name: 'Programming', count: 14 },
  { name: 'Receipt', count: 9 },
  { name: 'Ash', count: 6 },
  { name: 'Recipes', count: 4 },
  { name: 'Dermatology', count: 3 },
];

function harness(selected: string[] = [], tags = TAGS) {
  const rootRoute = createRootRoute({
    component: () => <TagPicker tags={tags} selected={selected} />,
  });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), history };
}

const rows = (c: HTMLElement) =>
  [...c.querySelectorAll('.tag-picker-name')].map((e) => e.textContent);

describe('TagPicker', () => {
  afterEach(cleanup);

  /* The API sorts by count so the busiest tags are reachable without searching;
     re-sorting alphabetically here would put the deadest ones first. */
  it('keeps the order the API sent, which is by how often each is used', async () => {
    const { container, findByLabelText } = harness();
    await findByLabelText('Find tags');
    expect(rows(container)).toEqual([
      'Programming',
      'Receipt',
      'Ash',
      'Recipes',
      'Dermatology',
    ]);
  });

  it('takes the chosen tags out of the list and puts them on top', async () => {
    const { container, findByLabelText } = harness(['Receipt']);
    await findByLabelText('Find tags');
    expect(rows(container)).not.toContain('Receipt');
    expect(container.querySelector('.tag-picker-selected')?.textContent).toContain('Receipt');
  });

  /* Substring, not prefix: people remember a word from the middle of a tag as readily as
     its first letter. Case-insensitive for the same reason. */
  it('matches anywhere in the name, ignoring case', async () => {
    const { container, findByLabelText } = harness();
    fireEvent.change(await findByLabelText('Find tags'), { target: { value: 'rec' } });
    await waitFor(() => expect(rows(container)).toEqual(['Receipt', 'Recipes']));

    fireEvent.change(await findByLabelText('Find tags'), { target: { value: 'MATOL' } });
    await waitFor(() => expect(rows(container)).toEqual(['Dermatology']));
  });

  it('ignores surrounding whitespace, which a paste brings along', async () => {
    const { container, findByLabelText } = harness();
    fireEvent.change(await findByLabelText('Find tags'), { target: { value: '  ash  ' } });
    await waitFor(() => expect(rows(container)).toEqual(['Ash']));
  });

  it('adds a tag to the filter, accumulating rather than replacing', async () => {
    const { findByText, history } = harness(['Receipt']);
    fireEvent.click(await findByText('Ash'));
    await waitFor(() => {
      expect(history.location.href).toContain('Receipt');
      expect(history.location.href).toContain('Ash');
    });
  });

  it('removes a tag from its chip', async () => {
    const { findByLabelText, history } = harness(['Receipt', 'Ash']);
    fireEvent.click(await findByLabelText('Remove tag filter: Receipt'));
    await waitFor(() => {
      expect(history.location.href).toContain('Ash');
      expect(history.location.href).not.toContain('Receipt');
    });
  });

  it('keeps the last tag out of the URL rather than leaving ?tag= behind', async () => {
    const { findByLabelText, history } = harness(['Receipt']);
    fireEvent.click(await findByLabelText('Remove tag filter: Receipt'));
    await waitFor(() => expect(history.location.href).not.toContain('tag'));
  });

  /*
   * The query survives a pick on purpose: selecting several related tags is the common
   * case, and clearing the field would send the user back to type "rec" again.
   */
  it('leaves the search in place after a pick, so a related tag is still one tap away', async () => {
    const { container, findByLabelText, findByText, rerender } = harness();
    fireEvent.change(await findByLabelText('Find tags'), { target: { value: 'rec' } });
    await waitFor(() => expect(rows(container)).toEqual(['Receipt', 'Recipes']));
    fireEvent.click(await findByText('Receipt'));
    // The URL is what changes; the component is re-rendered with the new selection.
    await waitFor(() =>
      expect((container.querySelector('.search-field') as HTMLInputElement).value).toBe('rec'),
    );
    void rerender;
  });

  /* Two situations, two messages: having chosen every tag is a finished job, not a
     failed search, and one message for both would read as something going wrong. */
  it('distinguishes having chosen everything from having matched nothing', async () => {
    const { container, findByLabelText } = harness(['Programming', 'Receipt', 'Ash', 'Recipes', 'Dermatology']);
    await findByLabelText('Find tags');
    expect(container.querySelector('.tag-picker-empty')?.textContent).toBe('Every tag is chosen.');

    fireEvent.change(await findByLabelText('Find tags'), { target: { value: 'zzz' } });
    await waitFor(() =>
      expect(container.querySelector('.tag-picker-empty')?.textContent).toBe('No tags match.'),
    );
  });

  /* Auto-focusing would raise the keyboard over the most-used tags, which are already on
     screen. Android does not focus it either. */
  it('does not steal focus when it opens', async () => {
    const { findByLabelText } = harness();
    const field = await findByLabelText('Find tags');
    expect(document.activeElement).not.toBe(field);
  });
});
