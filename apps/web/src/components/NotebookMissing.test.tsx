import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { NotebookMissing } from './NotebookMissing.js';

function harness(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

const loaded = {
  data: { notebooks: [{ id: '1', name: 'Coupons', count: 5 }], unfiled: 0 },
  isSuccess: true,
};

describe('NotebookMissing', () => {
  afterEach(cleanup);

  /* The URL can name a notebook that no longer exists, and the empty list it produces
     must not look like a data problem. */
  it('says so when the URL names a notebook that is not there, with a way out', async () => {
    const { findByText } = harness(<NotebookMissing notebook="Receipts" notebooks={loaded} />);
    expect((await findByText(/No notebook named/)).textContent).toContain('Receipts');
    const out = await findByText('Show all notes');
    expect(out.getAttribute('href')).toBe('/notes');
  });

  it('says nothing for a notebook that exists, the inbox, or before the list has loaded', async () => {
    const cases = [
      <NotebookMissing key="a" notebook="Coupons" notebooks={loaded} />,
      <NotebookMissing key="b" notebook={UNFILED} notebooks={loaded} />,
      <NotebookMissing key="c" notebook={undefined} notebooks={loaded} />,
      <NotebookMissing key="d" notebook="Receipts" notebooks={{ data: undefined, isSuccess: false }} />,
    ];
    for (const node of cases) {
      const { container } = harness(node);
      await new Promise((r) => setTimeout(r, 0));
      expect(container.querySelector('.bad')).toBeNull();
      cleanup();
    }
  });
});
