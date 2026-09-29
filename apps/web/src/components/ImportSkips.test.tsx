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

/** `Link` needs a router; one route is enough to render the panel under it. */
async function mount(running: boolean) {
  const rootRoute = createRootRoute({ component: () => <ImportSkips log={log} running={running} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/import'] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByText('Sample receipt');
}

afterEach(() => {
  cleanup();
  delete window.UnbentApp;
});

describe('ImportSkips', () => {
  it('links each row to a new tab in a browser, even mid-run', async () => {
    await mount(true);
    const link = screen.getByRole('link', { name: 'Sample receipt' });
    expect(link.getAttribute('target')).toBe('_blank');
  });

  /** The app has no tabs: a row would navigate in place, and leaving ends the import. */
  it('keeps the rows from opening while the Android app is running an import', async () => {
    window.UnbentApp = { postMessage: () => {} };
    await mount(true);
    expect(screen.queryByRole('link', { name: 'Sample receipt' })).toBeNull();
    expect(screen.getByText(/open once the import finishes/)).toBeTruthy();
  });

  it('links the rows again in the app once the run is over', async () => {
    window.UnbentApp = { postMessage: () => {} };
    await mount(false);
    expect(screen.getByRole('link', { name: 'Sample receipt' })).toBeTruthy();
    expect(screen.queryByText(/open once the import finishes/)).toBeNull();
  });
});
