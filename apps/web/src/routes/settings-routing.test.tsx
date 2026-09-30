import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { SettingsLayout } from '../components/SettingsLayout.js';

/** Whether an import is running, as the section reads it from the run's store. */
let importRunning = false;
vi.mock('../import-run.js', () => ({ useImportRunning: () => importRunning }));

/**
 * The section's navigation, exercised against a real router.
 *
 * Two things here are easy to get subtly wrong and impossible to notice by reading: that
 * `/settings` lands on a child rather than rendering an empty shell, and that it does so
 * with `replace`, without which Back re-enters the redirect and traps the user in the
 * section. Both are pinned below.
 *
 * The routes are rebuilt rather than imported from the generated tree so the test needs
 * no session gate, no API, and no loaders.
 */
function harness(initial: string) {
  const rootRoute = createRootRoute({ component: Outlet });

  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => (
      <SettingsLayout>
        <Outlet />
      </SettingsLayout>
    ),
  });

  const indexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: '/settings/notebooks', replace: true });
    },
  });

  const child = (path: string, text: string) =>
    createRoute({
      getParentRoute: () => settingsRoute,
      path,
      component: () => <p>{text}</p>,
    });

  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    component: () => <p>note list</p>,
  });

  const routeTree = rootRoute.addChildren([
    notesRoute,
    settingsRoute.addChildren([
      indexRoute,
      child('/notebooks', 'notebooks page'),
      child('/notebooks/$notebookId', 'fields page'),
      createRoute({ getParentRoute: () => settingsRoute, path: '/import', component: () => <p>import page</p> }),
      child('/export', 'export page'),
      child('/maintenance', 'maintenance page'),
    ]),
  ]);

  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree, history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );

  return router;
}

describe('settings section routing', () => {
  // The router restores scroll on navigation and jsdom has no window.scrollTo.
  beforeAll(() => {
    vi.stubGlobal('scrollTo', () => {});
  });

  afterEach(() => {
    cleanup();
    importRunning = false;
  });

  it('lands on notebooks rather than rendering an empty section root', async () => {
    const router = harness('/settings');
    await waitFor(() => expect(screen.getByText('notebooks page')).toBeTruthy());
    expect(router.state.location.pathname).toBe('/settings/notebooks');
  });

  it('replaces the section root in history, so Back leaves the section', async () => {
    const router = harness('/notes');
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());

    await router.navigate({ to: '/settings' });
    await waitFor(() => expect(screen.getByText('notebooks page')).toBeTruthy());

    // Without `replace` on the redirect, this step lands back on /settings, which
    // redirects forward again and the user can never get out.
    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/notes'));
  });

  it('keeps Notebooks lit on a notebook\'s own fields page', async () => {
    harness('/settings/notebooks/abc');
    await waitFor(() => expect(screen.getByText('fields page')).toBeTruthy());

    const active = document.querySelectorAll('.settings-nav-item.active');
    expect(active.length).toBe(1);
    expect(active[0]?.textContent).toBe('Notebooks');
  });

  it('marks only the current section in the sub-nav', async () => {
    harness('/settings/maintenance');
    await waitFor(() => expect(screen.getByText('maintenance page')).toBeTruthy());

    const active = document.querySelectorAll('.settings-nav-item.active');
    expect(active.length).toBe(1);
    expect(active[0]?.textContent).toBe('Maintenance');
  });

  /*
   * The sub-nav used to go inert for a whole import, because leaving the page ended it.
   * The run lives in `import-run.ts` now, so every page stays reachable during one.
   */
  it('keeps the sub-nav usable while an import is running', async () => {
    importRunning = true;
    harness('/settings/import');
    await waitFor(() => expect(screen.getByText('import page')).toBeTruthy());
    expect(document.querySelectorAll('.settings-nav-disabled').length).toBe(0);
    expect(screen.getByRole('link', { name: 'Tags' })).toBeTruthy();
  });

  /**
   * The Android app's settings live in the app, so their entry exists only there, and it
   * asks the app rather than navigating. Checked against a running import too: the run
   * outlives the page but not the site, and changing the instance reloads the site.
   */
  describe('inside the Android app', () => {
    afterEach(() => {
      delete window.UnbentApp;
    });

    it('offers nothing of the app in a browser', async () => {
      harness('/settings/notebooks');
      await waitFor(() => expect(screen.getByText('notebooks page')).toBeTruthy());
      expect(screen.queryByText('App settings')).toBeNull();
    });

    it("asks the app for its own settings", async () => {
      const postMessage = vi.fn();
      window.UnbentApp = { postMessage };
      harness('/settings/notebooks');
      await waitFor(() => expect(screen.getByText('notebooks page')).toBeTruthy());
      screen.getByRole('button', { name: 'App settings' }).click();
      expect(postMessage).toHaveBeenCalledWith('{"type":"app-settings"}');
    });

    it('holds the entry inert while an import runs', async () => {
      window.UnbentApp = { postMessage: vi.fn() };
      importRunning = true;
      harness('/settings/import');
      await waitFor(() => expect(screen.getByText('import page')).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'App settings' })).toBeNull();
      expect(screen.getByText('App settings').getAttribute('aria-disabled')).toBe('true');
    });
  });
});
