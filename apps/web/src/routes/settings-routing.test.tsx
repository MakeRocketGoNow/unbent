import { useEffect } from 'react';
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
import {
  SettingsBusyProvider,
  SettingsLayout,
  useSettingsBusy,
} from '../components/SettingsLayout.js';

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
/** An import page that reports itself running, the way `Import` does while its worker runs. */
function RunningImport() {
  const { setImportRunning } = useSettingsBusy();
  useEffect(() => {
    setImportRunning(true);
    return () => setImportRunning(false);
  }, [setImportRunning]);
  return <p>import page</p>;
}

function harness(initial: string, importPage: () => React.ReactElement = () => <p>import page</p>) {
  // The flag lives above the section now, where the shell mounts it beside the rail.
  const rootRoute = createRootRoute({
    component: () => (
      <SettingsBusyProvider>
        <Outlet />
      </SettingsBusyProvider>
    ),
  });

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
      createRoute({ getParentRoute: () => settingsRoute, path: '/import', component: importPage }),
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

  afterEach(cleanup);

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
   * A running import dies with its page, and the sub-nav refuses to leave it. The flag
   * that says so is held above the section now, so the rail can refuse too; this pins
   * that lifting it changed nothing for the sub-nav.
   */
  it('makes the sub-nav inert while an import is running', async () => {
    harness('/settings/import', RunningImport);
    await waitFor(() => expect(screen.getByText('import page')).toBeTruthy());
    await waitFor(() =>
      expect(document.querySelectorAll('.settings-nav-disabled').length).toBeGreaterThan(0),
    );
    // The import's own entry stays a link, so the page does not lose its own tab.
    expect(screen.getByRole('link', { name: 'Import' })).toBeTruthy();
  });
});
