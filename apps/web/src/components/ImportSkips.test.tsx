import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ImportSkips } from './ImportSkips.js';
import { emptySkipLog, recordSkip } from './import-skips.js';

const log = recordSkip(emptySkipLog, { title: 'Sample receipt', noteId: 'n-1', earlierInFile: true });

/** `Link` needs a router; one route is enough to render the list under it. */
async function mount() {
  const rootRoute = createRootRoute({ component: () => <ImportSkips log={log} run={1} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/import'] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByText('Sample receipt');
}

afterEach(cleanup);

describe('ImportSkips', () => {
  /*
   * In place, not a new tab: the run outlives the import page now, so following a row
   * and coming back finds the same list. In the Android app a new tab would not exist.
   */
  it('links each row to its note in place', async () => {
    await mount();
    const link = screen.getByRole('link', { name: 'Sample receipt' });
    expect(link.getAttribute('href')).toBe('/notes/n-1');
    expect(link.hasAttribute('target')).toBe(false);
  });
});
