import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

const deleteUser = vi.fn();
const signOut = vi.fn(() => Promise.resolve());
const refreshSession = vi.fn(() => Promise.resolve());
let session: { user: { email: string } } | null = { user: { email: 'someone@example.com' } };
let pending = false;

vi.mock('../auth-client.js', () => ({
  deleteUser: (body: unknown) => deleteUser(body),
  signOut: () => signOut(),
  refreshSession: () => refreshSession(),
  useSession: () => ({ data: session, isPending: pending }),
}));

const { Route } = await import('./delete-account.js');

/**
 * The page that stands between the emailed link and the deletion.
 *
 * Its whole reason to exist is that opening a link must not be the deletion: Better Auth's
 * own callback deletes on a GET, and a GET is fired by prefetches, scanners and restored
 * tabs. So the case worth pinning hardest is the boring one — rendering this page calls
 * nothing.
 */
function harness(search = '?token=tok-123') {
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: '/delete-account',
    validateSearch: Route.options.validateSearch,
    component: Route.options.component,
  });
  const goodbye = createRoute({
    getParentRoute: () => rootRoute,
    path: '/goodbye',
    component: () => <p>Your account is deleted.</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, goodbye]),
    history: createMemoryHistory({ initialEntries: [`/delete-account${search}`] }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), router };
}

describe('/delete-account', () => {
  afterEach(() => {
    cleanup();
    deleteUser.mockReset();
    signOut.mockClear();
    refreshSession.mockClear();
    session = { user: { email: 'someone@example.com' } };
    pending = false;
  });

  /** The point of the page. Loading it — however it was loaded — destroys nothing. */
  it('deletes nothing on load', async () => {
    const { findByRole } = harness();
    await findByRole('button', { name: 'Delete my account' });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('names the account before asking about it', async () => {
    const { findByText } = harness();
    expect(await findByText(/someone@example.com/)).toBeTruthy();
  });

  /** Pressing it is the deletion, and the token is what makes the POST count. */
  it('spends the token only when the button is pressed', async () => {
    deleteUser.mockResolvedValue({ data: { success: true } });
    const { findByRole } = harness();

    fireEvent.click(await findByRole('button', { name: 'Delete my account' }));
    expect(deleteUser).toHaveBeenCalledWith({ token: 'tok-123' });
    expect(await screen.findByText('Your account is deleted.')).toBeTruthy();
  });

  /**
   * The wrong browser is worth saying before the press, not after: the link is still
   * unspent, and the fix is to open it somewhere else.
   */
  it('says so when this browser holds no session, and offers no button', async () => {
    session = null;
    const { findByText } = harness();
    expect(await findByText(/not signed in here/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  /** A truncated or retyped link explains itself rather than rendering an error. */
  it('explains a link with no token', async () => {
    const { findByText } = harness('');
    expect(await findByText(/missing its confirmation code/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  /**
   * Better Auth answers the deleting request by re-writing the session-cache cookie from
   * the session it resolved on the way in, so without this the browser walks away holding
   * a five-minute claim to an account that no longer exists — and `/login` turns away
   * anyone it believes is signed in. The cookies are HttpOnly, so sign-out is the only
   * thing that can clear them.
   */
  it('clears the session the deletion leaves behind', async () => {
    deleteUser.mockResolvedValue({ data: { success: true } });
    const { findByRole } = harness();

    fireEvent.click(await findByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText('Your account is deleted.')).toBeTruthy();
    expect(signOut).toHaveBeenCalled();
  });

  /** But a failure to sign out must not strand the page: the account is already gone. */
  it('still lands on goodbye if signing out fails', async () => {
    deleteUser.mockResolvedValue({ data: { success: true } });
    signOut.mockRejectedValueOnce(new Error('offline'));
    const { findByRole } = harness();

    fireEvent.click(await findByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText('Your account is deleted.')).toBeTruthy();
  });

  /** A spent or expired token leaves the page put, with the reason on screen. */
  it('keeps the page and shows why when the token is refused', async () => {
    deleteUser.mockResolvedValue({ error: { message: 'Invalid token' } });
    const { findByRole, findByText } = harness();

    fireEvent.click(await findByRole('button', { name: 'Delete my account' }));
    expect(await findByText('Invalid token')).toBeTruthy();
    expect(screen.queryByText('Your account is deleted.')).toBeNull();
  });
});
