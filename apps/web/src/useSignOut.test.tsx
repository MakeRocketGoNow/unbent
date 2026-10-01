import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useSignOut } from './useSignOut.js';
import { SignOutSnackbar } from './components/SignOutSnackbar.js';
import { refreshSession, signOut } from './auth-client.js';
import { rememberSession, rememberedSession } from './session-memory.js';
import { setReachableForTests } from './connectivity.js';
import { claimImportFor } from './import-run.js';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('./auth-client.js', () => ({
  signOut: vi.fn().mockResolvedValue({}),
  refreshSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('./import-run.js', () => ({ claimImportFor: vi.fn() }));

/**
 * Where signing out lands. In a browser, the sign-in page. Inside the Android app, nowhere
 * on the page: the app is told, forgets its own copy of the session, and puts its own
 * sign-in screen in place of this one.
 */
describe('useSignOut', () => {
  afterEach(() => {
    cleanup();
    delete window.UnbentApp;
    vi.clearAllMocks();
  });

  it('goes to the sign-in page in a browser', async () => {
    renderHook(() => useSignOut()).result.current();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/login', replace: true }));
    expect(signOut).toHaveBeenCalled();
    expect(refreshSession).toHaveBeenCalled();
  });

  it('hands over to the app inside it', async () => {
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    renderHook(() => useSignOut()).result.current();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('{"type":"signed-out"}'));
    expect(navigate).not.toHaveBeenCalled();
    // Refreshing would make the shell report `unauthorized` to an app that is already
    // signing out.
    expect(refreshSession).not.toHaveBeenCalled();
  });

  /*
   * The device's memory of who was signed in is what lets the app open offline as them
   * (`session-memory.ts`). Inside the app the hook returns before refreshing the session,
   * so the forgetting has to happen ahead of that — the path most likely to skip it.
   */
  it.each([
    ['in a browser', false],
    ['inside the app', true],
  ])('forgets who was signed in, %s', async (_, hosted) => {
    rememberSession({ id: 'u1', email: 'someone@example.com' });
    if (hosted) window.UnbentApp = { postMessage: vi.fn() };
    renderHook(() => useSignOut()).result.current();
    await waitFor(() => expect(rememberedSession()).toBeNull());
  });

  /*
   * A running import sends whatever cookie the page holds, so it must not outlive the
   * session it was started under. Inside the app the store is never refreshed, so the
   * shell's own drop never runs — this is the only one on that path.
   */
  it.each([
    ['in a browser', false],
    ['inside the app', true],
  ])('drops a running import, %s', async (_, hosted) => {
    if (hosted) window.UnbentApp = { postMessage: vi.fn() };
    renderHook(() => useSignOut()).result.current();
    await waitFor(() => expect(claimImportFor).toHaveBeenCalledWith(undefined));
  });

  /*
   * The request could not reach the server. In a browser nothing has been signed out —
   * the HttpOnly cookie is still good — so nothing is cleared and nothing pretends it was;
   * the menu offers Sign out there only with a connection. In the Android app the app
   * clears its own cookies when told, so the sign-out completes on the device.
   */
  it('leaves a browser signed in when the server did not hear the sign-out, and says so', async () => {
    vi.mocked(signOut).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    rememberSession({ id: 'u1', email: 'someone@example.com' });
    render(<SignOutSnackbar />);
    renderHook(() => useSignOut()).result.current();
    expect(await screen.findByText('Couldn’t sign out.')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(rememberedSession()).not.toBeNull();
    expect(claimImportFor).not.toHaveBeenCalled();

    // Try again, and this time the server hears it.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/login', replace: true }));
    expect(screen.queryByText('Couldn’t sign out.')).toBeNull();
  });

  /* Try again could only fail the same way with no connection, so it is withdrawn and the
     reason given instead; it comes back with the connection. */
  it('says signing out needs a connection, with nothing to retry, while offline', async () => {
    vi.mocked(signOut).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<SignOutSnackbar />);
    renderHook(() => useSignOut()).result.current();
    await screen.findByText('Couldn’t sign out.');

    act(() => setReachableForTests(false));
    expect(screen.getByText('Signing out needs a connection.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    act(() => setReachableForTests(true));
    expect(screen.getByText('Couldn’t sign out.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
  });

  it('signs out on the device inside the app even when the server did not hear it', async () => {
    vi.mocked(signOut).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    const deleted = vi.fn(async () => true);
    vi.stubGlobal('caches', { delete: deleted });
    rememberSession({ id: 'u1', email: 'someone@example.com' });
    renderHook(() => useSignOut()).result.current();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith('{"type":"signed-out"}'));
    expect(rememberedSession()).toBeNull();
    expect(deleted).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
