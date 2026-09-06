import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { NotebookSelect } from './NotebookSelect.js';
import { SortSelect } from './SortSelect.js';
import { DateRange } from './DateRange.js';
import { ExportLink } from './ExportLink.js';
import { TagFilter } from './TagFilter.js';

const NOTEBOOKS = {
  data: { notebooks: [{ id: '1', name: 'Coupons', count: 5 }], unfiled: 4 },
  isSuccess: true,
};
const TAGS = [{ name: 'Receipt', count: 9 }, { name: 'Ash', count: 2 }];

function harness(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <div className="sidebar">{node}</div> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

/**
 * The sidebar's control stack, as a set of classes.
 *
 * These five components were one, and splitting them is the kind of change that is easy to
 * make look right in a diff and wrong on screen: the stylesheet targets class names, and a
 * wrapper dropped or a class renamed on the way out would not fail a type check or any
 * other test here. This pins the contract between the markup and `styles.css` — the order
 * the sidebar stacks them in, the shared `.notebook-scope` both selects wear, and the three
 * decisions the notebook picker carries that a hand-copy would have lost.
 */
describe('the sidebar filter controls', () => {
  // `TagFilter` renders a `Disclosure`, and jsdom ships no matchMedia. Desktop width.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the classes the stylesheet targets, in the order they stack', async () => {
    const { container, findByLabelText } = harness(
      <>
        <NotebookSelect notebook={undefined} notebooks={NOTEBOOKS} endsFilters={false} />
        <SortSelect sort={undefined} order={undefined} />
        <DateRange from="2026-01-01" to={undefined} />
        <ExportLink filter={{ from: '2026-01-01' }} sort={undefined} total={12} />
        <TagFilter tags={TAGS} selected={['Receipt']} />
      </>,
    );
    await findByLabelText('Notebook');

    // Every class `styles.css` has a rule for. A rename here is a silent visual break.
    const classes = [...container.querySelectorAll('[class]')]
      .map((e) => e.className)
      .filter((c) => typeof c === 'string' && c.length > 0);
    expect(classes).toContain('notebook-scope-wrap');
    expect(classes).toContain('notebook-scope');
    expect(classes).toContain('date-range');
    expect(classes).toContain('export-filtered small');
    expect(classes).toContain('disclosure tag-filter-wrap');
    expect(classes).toContain('tag-filter');
    expect(classes).toContain('tag-filter-item active');

    // Two selects, both wearing the shared control class: notebook then sort.
    const selects = [...container.querySelectorAll('select')];
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual(['Notebook', 'Sort notes']);
    expect(selects.every((s) => s.className === 'notebook-scope')).toBe(true);

    // The disclosure summary still carries the active tag rather than a count.
    expect(container.querySelector('.tag-filter-active')?.textContent).toBe('Receipt');
    expect(container.querySelector('.tag-filter-summary-count')).toBeNull();
  });

  it('keeps the Inbox option conditional and the desync warning', async () => {
    const { container, findByLabelText } = harness(
      <NotebookSelect notebook="Gone" notebooks={NOTEBOOKS} />,
    );
    await findByLabelText('Notebook');
    expect(container.querySelector('.bad')?.textContent).toContain('No notebook named');
    const opts = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toEqual(['All notebooks', 'Coupons (5)', 'Inbox (4)']);
  });

  it('drops the Inbox option when nothing is unfiled and it is not the filter', async () => {
    const { container, findByLabelText } = harness(
      <NotebookSelect
        notebook={undefined}
        notebooks={{ data: { notebooks: NOTEBOOKS.data.notebooks, unfiled: 0 }, isSuccess: true }}
      />,
    );
    await findByLabelText('Notebook');
    const opts = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toEqual(['All notebooks', 'Coupons (5)']);
  });

  it('shows the tag count in the summary when nothing is selected', async () => {
    const { container, findByText } = harness(<TagFilter tags={TAGS} selected={[]} />);
    await findByText('Tags');
    expect(container.querySelector('.tag-filter-summary-count')?.textContent).toBe('2');
  });
});
