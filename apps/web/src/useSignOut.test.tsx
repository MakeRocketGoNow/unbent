import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSignOut } from './useSignOut.js';
import { refreshSession, signOut } from './auth-client.js';
import { rememberSession, rememberedSession } from './session-memory.js';

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
});
