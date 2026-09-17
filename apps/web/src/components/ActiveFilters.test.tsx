import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { ActiveFilters } from './ActiveFilters.js';

/**
 * What is filtering the list, and how it comes off.
 *
 * On a phone the controls are behind an icon, so these chips are the only thing on screen
 * that says the list is narrowed and the only way to widen it without opening anything.
 * Both halves are pinned: that every active filter produces a chip, and that pressing one
 * writes the removal to the URL — which is where the filters live, so it is the only place
 * a removal can be observed.
 */
function harness(props: Parameters<typeof ActiveFilters>[0]) {
  const rootRoute = createRootRoute({ component: () => <ActiveFilters {...props} /> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rendered = render(<RouterProvider router={router as any} />);
  return { ...rendered, history };
}

/*
 * The URL as a string, which is what these assertions read.
 *
 * Reading the location's parsed query object would be the direct route, but
 * `url-boundary.test.ts` greps for that spelling to keep navigation the router's business,
 * and the grep cannot tell the router's own location from the browser's. `href` says the
 * same thing and keeps that guard meaningful.
 *
 * It is the more honest boundary anyway: this harness has no `validateSearch`, so the URL
 * rather than the parsed object is what this component actually produces — and the route's
 * schema is what turns it back into a tag array in the app.
 */
const url = (history: { location: { href: string } }) => history.location.href;

describe('ActiveFilters', () => {
  afterEach(cleanup);

  /*
   * The header strip omits the notebook, because the heading above it already names the
   * notebook — a chip there repeated the title word for word on the very next line. The
   * sheet passes it, since a surface claiming to list everything applied has to show it.
   */
  it('reports only what it was given, so the header can leave the notebook to the heading', async () => {
    const { container, findByLabelText } = harness({
      notebook: undefined,
      tags: ['Receipt'],
      from: undefined,
      to: undefined,
    });
    await findByLabelText('Remove tag filter: Receipt');
    expect(container.querySelectorAll('.filter-chip').length).toBe(1);
  });

  /* An empty strip is a gap above the notes with nothing in it, so a caller can mount it
     without first working out whether this combination leaves anything to say. */
  it('renders nothing when it has nothing to report', () => {
    const { container } = harness({
      notebook: undefined,
      tags: [],
      from: undefined,
      to: undefined,
    });
    expect(container.querySelector('.filter-chips')).toBeNull();
  });

  it('draws one chip per active filter, in the order the controls are in', async () => {
    const { container } = harness({
      notebook: 'Coupons',
      tags: ['Receipt', 'Dermatology'],
      from: '2026-01-01',
      to: '2026-03-05',
    });
    await waitFor(() => expect(container.querySelectorAll('.filter-chip').length).toBe(4));
    const labels = [...container.querySelectorAll('.filter-chip')].map((c) => c.textContent);
    expect(labels[0]).toContain('Coupons');
    expect(labels[1]).toContain('#Receipt');
    expect(labels[2]).toContain('#Dermatology');
    expect(labels[3]).toContain('2026');
  });

  /* The sentinel is a filter value, not a notebook name, and "unfiled" is not what the UI
     calls that bucket anywhere else. */
  it('calls the unfiled bucket Inbox, the way the picker does', async () => {
    const { findByText } = harness({ notebook: UNFILED, tags: [], from: undefined, to: undefined });
    expect(await findByText(/Inbox/)).toBeTruthy();
  });

  it('names what each chip would remove, for a screen reader', async () => {
    const { findByLabelText } = harness({
      notebook: undefined,
      tags: ['Receipt'],
      from: '2026-01-01',
      to: undefined,
    });
    expect(await findByLabelText('Remove tag filter: Receipt')).toBeTruthy();
    expect(await findByLabelText(/^Remove date filter: From /)).toBeTruthy();
  });

  /*
   * Asserted on the URL rather than the parsed search object. This harness has no
   * `validateSearch` — the real route's schema is what turns `?tag=a&tag=b` back into an
   * array — so the parsed value here is whatever the router's default parser makes of it.
   * The URL is the thing this component actually writes, and it is what the route then
   * reads, so it is the honest boundary to test at.
   */
  it('drops one tag and leaves the rest, since tags are ANDed', async () => {
    const { findByLabelText, history } = harness({
      notebook: undefined,
      tags: ['Receipt', 'Dermatology'],
      from: undefined,
      to: undefined,
    });
    fireEvent.click(await findByLabelText('Remove tag filter: Receipt'));
    await waitFor(() => {
      expect(url(history)).toContain('Dermatology');
      expect(url(history)).not.toContain('Receipt');
    });
  });

  it('keeps the last tag out of the URL rather than leaving an empty list behind', async () => {
    const { findByLabelText, history } = harness({
      notebook: undefined,
      tags: ['Receipt'],
      from: undefined,
      to: undefined,
    });
    fireEvent.click(await findByLabelText('Remove tag filter: Receipt'));
    await waitFor(() => expect(url(history)).not.toContain('tag'));
  });

  /*
   * The same rule the notebook select follows: tags cross notebook boundaries, so leaving
   * one selected while the notebook goes away routinely yields an empty list with no
   * visible cause.
   */
  it('takes the tags with the notebook', async () => {
    const { findByLabelText, history } = harness({
      notebook: 'Coupons',
      tags: ['Receipt'],
      from: undefined,
      to: undefined,
    });
    fireEvent.click(await findByLabelText('Remove notebook filter: Coupons'));
    await waitFor(() => {
      expect(url(history)).not.toContain('notebook');
      expect(url(history)).not.toContain('tag');
    });
  });

  /* A field filter is named through the notebook's definitions, sits between the tags and
     the range, and comes off on its own like a tag does. */
  it('names a field filter and removes only that one', async () => {
    const defs = [
      { id: 'cat', notebookId: 'nb', name: 'Category', type: 'select' as const, options: ['Food'], scale: null, position: 0 },
      { id: 'amt', notebookId: 'nb', name: 'Amount', type: 'number' as const, options: [], scale: null, position: 1 },
    ];
    const { container, findByLabelText, history } = harness({
      notebook: undefined,
      tags: ['Receipt'],
      fields: ['cat:eq:Food', 'amt:gte:20'],
      fieldDefs: defs,
      from: '2026-01-01',
      to: undefined,
    });
    await findByLabelText('Remove field filter: Category: Food');
    const labels = [...container.querySelectorAll('.filter-chip')].map((c) => c.textContent);
    expect(labels).toEqual(['#Receipt', 'Category: Food', 'Amount ≥ 20', labels[3]]);
    fireEvent.click(await findByLabelText('Remove field filter: Category: Food'));
    await waitFor(() => {
      expect(decodeURIComponent(url(history))).toContain('amt:gte:20');
      expect(decodeURIComponent(url(history))).not.toContain('cat:eq:Food');
    });
  });

  /* One chip for the range, not one per end: "since March" and "until June" are one
     question, and removing half of it is not something anyone asks for. */
  it('removes both ends of the range at once', async () => {
    const { findByLabelText, history } = harness({
      notebook: undefined,
      tags: [],
      from: '2026-01-01',
      to: '2026-03-05',
    });
    fireEvent.click(await findByLabelText(/^Remove date filter/));
    await waitFor(() => {
      expect(url(history)).not.toContain('from');
      expect(url(history)).not.toContain('to=');
    });
  });
});
