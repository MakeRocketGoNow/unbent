import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSignOut } from './useSignOut.js';
import { refreshSession, signOut } from './auth-client.js';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('./auth-client.js', () => ({
  signOut: vi.fn().mockResolvedValue({}),
  refreshSession: vi.fn().mockResolvedValue(null),
}));

/**
 * Where signing out lands. In a browser, the sign-in page. Inside the Android app, nowhere
 * on the page: the app is told, forgets its own copy of the session, and puts its own
 * sign-in screen in place of this one.
 */
describe('useSignOut', () => {
  afterEach(() => {
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
});
