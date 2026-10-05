import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { NotebookMissing, isNotebookMissing } from './NotebookMissing.js';

function harness(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const history = createMemoryHistory({ initialEntries: ['/notes?notebook=Receipts'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

const loaded = {
  data: { notebooks: [{ id: '1', name: 'Coupons', count: 5 }], unfiled: 0 },
  isSuccess: true,
};
const loading = { data: undefined, isSuccess: false };

describe('NotebookMissing', () => {
  afterEach(cleanup);

  /* The URL can name a notebook that no longer exists, and the empty list it produces
     must not look like a data problem. */
  it('says so in a labelled region, with the name in its line', async () => {
    harness(<NotebookMissing notebook="Receipts" notebooks={loaded} whole />);
    const region = await screen.findByRole('region', { name: 'Notebook not found' });
    expect(screen.getByRole('heading', { level: 3, name: 'Notebook not found' })).toBeTruthy();
    expect(region.textContent).toContain(
      'There is no notebook named “Receipts”. It may have been renamed or deleted.',
    );
  });

  /** The way out is navigation, so a real link — outlined, since leaving is not the view's point. */
  it('offers All notes as a link drawn as the outlined button', async () => {
    harness(<NotebookMissing notebook="Receipts" notebooks={loaded} whole />);
    const out = await screen.findByRole('link', { name: 'Show all notes' });
    expect(out.getAttribute('href')).toBe('/notes');
    expect(out.className).toContain('btn-secondary');
    expect(out.className).not.toContain('btn-primary');
  });

  /** Red was tried and was wrong: a stale link is nobody's fault. */
  it('draws nothing in the warning colour and is not an alert', async () => {
    const { container } = harness(<NotebookMissing notebook="Receipts" notebooks={loaded} whole />);
    await screen.findByRole('region', { name: 'Notebook not found' });
    expect(container.querySelector('.bad')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing for a notebook that exists, the inbox, no notebook, or before the list has loaded', async () => {
    const cases = [
      <NotebookMissing key="a" notebook="Coupons" notebooks={loaded} whole />,
      <NotebookMissing key="b" notebook={UNFILED} notebooks={loaded} whole />,
      <NotebookMissing key="c" notebook={undefined} notebooks={loaded} whole />,
      <NotebookMissing key="d" notebook="Receipts" notebooks={loading} whole />,
    ];
    for (const node of cases) {
      harness(node);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('region', { name: 'Notebook not found' })).toBeNull();
      cleanup();
    }
  });
});

describe('isNotebookMissing', () => {
  it('is true only once the list has loaded without the name', () => {
    expect(isNotebookMissing('Receipts', loaded, true)).toBe(true);
    expect(isNotebookMissing('Receipts', loading, true)).toBe(false);
    expect(isNotebookMissing('Coupons', loaded, true)).toBe(false);
    expect(isNotebookMissing(UNFILED, loaded, true)).toBe(false);
    expect(isNotebookMissing(undefined, loaded, true)).toBe(false);
  });

  /* The list's filter and the server match a notebook without case, so the link lists
     Coupons' notes; saying there is no such notebook over them would be wrong. */
  it('matches the name without case, as the list does', () => {
    expect(isNotebookMissing('coupons', loaded, true)).toBe(false);
    expect(isNotebookMissing('COUPONS', loaded, true)).toBe(false);
  });

  /* Mid-copy, or after a reset, the list lacks notebooks that exist. */
  it('is false while the library is not whole', () => {
    expect(isNotebookMissing('Receipts', loaded, false)).toBe(false);
  });
});
