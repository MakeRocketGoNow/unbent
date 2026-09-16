import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { NotebookSelect } from './NotebookSelect.js';

const NOTEBOOKS = {
  data: { notebooks: [{ id: '1', name: 'Coupons', count: 5 }], unfiled: 4 },
  isSuccess: true,
};

function harness(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <div className="sidebar">{node}</div> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

/**
 * The three decisions the notebook picker carries, which is why it is a component rather
 * than a `<select>` written where one is needed: the desync warning, and when the Inbox
 * option is worth offering at all. (The third, clearing the tag on change, is a navigation
 * and is pinned where the drawer pins the same rule.)
 *
 * These were part of a test of the whole desktop control stack, which pinned the stacking
 * order of five components against the stylesheet. That stack is gone — the filters sit
 * behind the header's icon at every width — and this is the one control left in the column.
 */
describe('NotebookSelect', () => {
  afterEach(cleanup);

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

  it('wears the classes the stylesheet targets', async () => {
    const { container, findByLabelText } = harness(
      <NotebookSelect notebook={undefined} notebooks={NOTEBOOKS} />,
    );
    const select = await findByLabelText('Notebook');
    expect(select.className).toBe('notebook-scope');
    expect(container.querySelector('.notebook-scope-wrap')).toBeTruthy();
  });
});
