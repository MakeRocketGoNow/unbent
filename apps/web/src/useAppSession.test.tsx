import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { rememberSession } from './session-memory.js';

vi.mock('./store/wipe.js', () => ({ wipeLocalStores: vi.fn(async () => {}), closeLocalStores: vi.fn(async () => {}) }));

/**
 * What the signed-in chrome reads while the session is asked again, against Better Auth's
 * real session store with only `fetch` stood in for, as in `auth-client.test.ts`. The
 * store is a module singleton, so each case imports a fresh copy.
 */
const USER = { id: 'u1', email: 'someone@example.com', name: 'Someone' };
const SESSION = {
  user: { ...USER, emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  session: { id: 's1', userId: 'u1', expiresAt: '2099-01-01T00:00:00.000Z', token: 't' },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fresh() {
  vi.resetModules();
  return {
    auth: await import('./auth-client.js'),
    useAppSession: (await import('./useAppSession.js')).useAppSession,
  };
}

const sessionChecks = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter(([url]) => String(url).includes('/get-session')).length;

describe('useAppSession', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /*
   * The store has no session to hold through this check, so it says `isPending` again,
   * the way a cold start does. Read as one, the shell went back to "Loading…" on every
   * reconnect and drew the whole app again from nothing.
   */
  it('keeps the remembered session while the server is asked again after it could not be', async () => {
    rememberSession(USER);
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Promise.reject(new TypeError('Failed to fetch')) as Promise<Response>);
    vi.stubGlobal('fetch', fetch);
    const { auth, useAppSession } = await fresh();
    const { result } = renderHook(() => useAppSession());
    await waitFor(() => expect(result.current).toEqual({ session: { user: USER }, isPending: false, unreachable: true }));

    let answer!: (r: Response) => void;
    fetch.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    const before = sessionChecks(fetch);
    void auth.refreshSession();
    await waitFor(() => expect(sessionChecks(fetch)).toBe(before + 1));
    expect(result.current).toEqual({ session: { user: USER }, isPending: false, unreachable: true });

    answer(json(200, SESSION));
    await waitFor(() => expect(result.current.unreachable).toBe(false));
    expect(result.current.session?.user.id).toBe('u1');
    expect(result.current.isPending).toBe(false);
  });

  it('still waits on the first check, with nobody drawn', async () => {
    rememberSession(USER);
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const { useAppSession } = await fresh();
    const { result } = renderHook(() => useAppSession());
    await waitFor(() => expect(sessionChecks(fetch)).toBe(1));
    expect(result.current).toEqual({ session: null, isPending: true, unreachable: false });
  });

  it('lets the server end a held session', async () => {
    rememberSession(USER);
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Promise.reject(new TypeError('Failed to fetch')) as Promise<Response>);
    vi.stubGlobal('fetch', fetch);
    const { auth, useAppSession } = await fresh();
    const { result } = renderHook(() => useAppSession());
    await waitFor(() => expect(result.current.unreachable).toBe(true));

    fetch.mockImplementation(async () => json(401, { message: 'Unauthorized' }));
    await auth.refreshSession();
    await waitFor(() => expect(result.current).toEqual({ session: null, isPending: false, unreachable: false }));
  });
});
