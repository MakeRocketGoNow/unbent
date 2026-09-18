import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
  useNavigate,
} from '@tanstack/react-router';
import { useShell } from './auth-gate.js';

/**
 * Which chrome goes around the page, while the page is changing.
 *
 * The router moves `location` to the destination as soon as a navigation starts and swaps
 * the rendered matches only once that route's loaders resolve, so anything selecting on
 * `location` renders the incoming route's chrome around the outgoing route's content for
 * the whole of that gap. Signing in is where it was visible: `/notes` loads four requests,
 * and for as long as they took, the topbar and `.shell.wide` were drawn around the still
 * rendered sign-in screen — and `wide` sets `max-width: none` over the centred 46rem
 * column of `.shell`, so the login card jumped to the left edge and stayed there.
 *
 * The shells here are the real ones by class name; what is asserted is that the class and
 * the content never disagree.
 */
function harness() {
  /** Held open so the assertions can happen while `/notes` is still loading. */
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });

  const rootRoute = createRootRoute({
    component: function RootLayout() {
      const shell = useShell();
      return (
        <main className={shell === 'app' ? 'shell wide' : 'shell centered'} data-testid="shell">
          {shell === 'app' && <p>chrome</p>}
          <Outlet />
        </main>
      );
    },
  });

  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: function LoginPage() {
      const navigate = useNavigate();
      return (
        <button onClick={() => void navigate({ href: '/notes', replace: true })}>
          sign-in screen
        </button>
      );
    },
  });

  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    loader: () => loading,
    component: () => <p>note list</p>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, notesRoute]),
    history: createMemoryHistory({ initialEntries: ['/login'] }),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<RouterProvider router={router as any} />);
  return { release };
}

const shellClass = () => screen.getByTestId('shell').className;

describe('the shell around a page that is still loading', () => {
  // The router restores scroll on navigation and jsdom has no window.scrollTo.
  beforeAll(() => {
    vi.stubGlobal('scrollTo', () => {});
  });

  afterEach(cleanup);

  /**
   * The bug, as the user met it: the sign-in screen visibly sliding left, seconds before
   * the notes it was waiting for arrived.
   */
  it('leaves the sign-in screen in the centred shell until the notes are ready', async () => {
    const { release } = harness();
    const signIn = await screen.findByText('sign-in screen');

    signIn.click();

    // The destination's loader is still open, so the sign-in screen is still what renders.
    await waitFor(() => expect(screen.getByText('sign-in screen')).toBeTruthy());
    expect(shellClass()).toBe('shell centered');
    expect(screen.queryByText('chrome')).toBeNull();

    release();
    await waitFor(() => expect(screen.getByText('note list')).toBeTruthy());
    expect(shellClass()).toBe('shell wide');
    expect(screen.getByText('chrome')).toBeTruthy();
  });
});
