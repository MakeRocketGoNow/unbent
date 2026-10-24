import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { useNotesLayout, type NotesViewMode } from './useNotesLayout.js';

/**
 * The class the mobile layout hangs on.
 *
 * Below 860px, `.note-open` is the entire difference between showing the note list and
 * showing the open note: the rest of that behaviour is CSS, which jsdom does not
 * evaluate. So this is the one piece worth pinning in a test: if the route no longer
 * reaches the grid, every mobile rule silently stops applying and nothing else fails.
 *
 * The routes are rebuilt rather than imported from the generated tree so the test needs no
 * session gate, no API and no loaders, the same approach as settings-routing.test.tsx.
 */
function harness(initial: string, mode: NotesViewMode = 'list') {
  const rootRoute = createRootRoute({ component: Outlet });

  function Shell() {
    const layout = useNotesLayout('/notes/$noteId', { mode });
    return (
      <div data-testid="grid" className={layout.className} style={layout.style}>
        <Outlet />
      </div>
    );
  }

  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    component: Shell,
  });

  const indexRoute = createRoute({
    getParentRoute: () => notesRoute,
    path: '/',
    component: () => <p>empty workspace</p>,
  });

  const noteRoute = createRoute({
    getParentRoute: () => notesRoute,
    path: '/$noteId',
    component: () => <p>open note</p>,
  });

  const routeTree = rootRoute.addChildren([notesRoute.addChildren([indexRoute, noteRoute])]);
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree, history });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<RouterProvider router={router as any} />);
  return router;
}

describe('useNotesLayout', () => {
  // The router restores scroll on navigation and jsdom has no window.scrollTo.
  beforeAll(() => vi.stubGlobal('scrollTo', () => {}));
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('does not mark the grid when no note is open', async () => {
    harness('/notes');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());
    expect(screen.getByTestId('grid').className).toBe('notes');
  });

  it('marks the grid when a note is open', async () => {
    harness('/notes/abc123');
    await waitFor(() => expect(screen.getByText('open note')).toBeTruthy());
    expect(screen.getByTestId('grid').className).toBe('notes note-open');
  });

  it('tracks navigation in both directions', async () => {
    const router = harness('/notes');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());

    await router.navigate({ to: '/notes/$noteId', params: { noteId: 'abc123' } });
    await waitFor(() => expect(screen.getByTestId('grid').className).toBe('notes note-open'));

    // Back to the list must clear it, or a phone shows a blank pane where the list was.
    router.history.back();
    await waitFor(() => expect(screen.getByTestId('grid').className).toBe('notes'));
  });

  /**
   * The width must reach the grid as a custom property and never as a
   * `grid-template-columns` declaration: inline layout properties outrank media queries,
   * so that would pin a phone to two columns whatever the stylesheet says.
   */
  it('exposes the width as a custom property only', async () => {
    localStorage.setItem('unbent.sidebarWidth', '360');
    harness('/notes');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());

    const grid = screen.getByTestId('grid');
    expect(grid.style.getPropertyValue('--sidebar-width')).toBe('360px');
    expect(grid.style.gridTemplateColumns).toBe('');
  });

  it('ignores a stored width outside the clamps', async () => {
    localStorage.setItem('unbent.sidebarWidth', '9999');
    harness('/notes');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());
    expect(screen.getByTestId('grid').style.getPropertyValue('--sidebar-width')).toBe('304px');
  });

  /*
   * Table mode is a class on the same grid, so the stylesheet can give the table the
   * whole width with no note open and its own dragged width beside one. Both widths
   * always reach the grid: the desktop filter panel reads the sidebar's over a table too.
   */
  it('marks the grid in table mode and keeps both widths on it', async () => {
    localStorage.setItem('unbent.sidebarWidth', '360');
    localStorage.setItem('unbent.tableWidth', '800');
    const router = harness('/notes', 'table');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());
    const grid = screen.getByTestId('grid');
    expect(grid.className).toBe('notes wide-view table-view');
    expect(grid.style.getPropertyValue('--table-width')).toBe('800px');
    expect(grid.style.getPropertyValue('--sidebar-width')).toBe('360px');
    expect(grid.style.gridTemplateColumns).toBe('');

    await router.navigate({ to: '/notes/$noteId', params: { noteId: 'abc123' } });
    await waitFor(() =>
      expect(screen.getByTestId('grid').className).toBe('notes note-open wide-view table-view'),
    );
  });

  it('clamps the table width on its own range', async () => {
    localStorage.setItem('unbent.tableWidth', '200');
    harness('/notes', 'table');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());
    expect(screen.getByTestId('grid').style.getPropertyValue('--table-width')).toBe('640px');
  });

  /*
   * The cards take the table's shape (`wide-view`) with a width of their own, so a width
   * dragged for one never resizes the other.
   */
  it('marks the grid in cards mode with the cards their own width', async () => {
    localStorage.setItem('unbent.tableWidth', '800');
    localStorage.setItem('unbent.cardsWidth', '520');
    harness('/notes', 'cards');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());
    const grid = screen.getByTestId('grid');
    expect(grid.className).toBe('notes wide-view cards-view');
    expect(grid.style.getPropertyValue('--cards-width')).toBe('520px');
    expect(grid.style.getPropertyValue('--table-width')).toBe('800px');
  });

  it('starts the cards two across when nothing has been dragged', async () => {
    localStorage.setItem('unbent.cardsWidth', '50');
    harness('/notes', 'cards');
    await waitFor(() => expect(screen.getByText('empty workspace')).toBeTruthy());
    expect(screen.getByTestId('grid').style.getPropertyValue('--cards-width')).toBe('384px');
  });
});
