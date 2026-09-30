import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markSignOutPending, pendingSignOut, rememberSession, rememberedSession } from './session-memory.js';

/**
 * Who `ensureSession` says is signed in, against Better Auth's real session store with
 * only `fetch` stood in for. The store is a module singleton that fetches once when it is
 * first read, so each case imports a fresh copy.
 *
 * What these hold is the distinction the route guard used to miss: only the server can
 * say nobody is signed in. A request that never arrives — no signal — or one that hangs
 * must leave whoever this device remembers signed in, instead of sending them to `/login`.
 */
const USER = { id: 'u1', email: 'someone@example.com', name: 'Someone' };
const SESSION = {
  user: { ...USER, emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  session: { id: 's1', userId: 'u1', expiresAt: '2099-01-01T00:00:00.000Z', token: 't' },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function freshEnsureSession() {
  vi.resetModules();
  return (await import('./auth-client.js')).ensureSession;
}

describe('ensureSession', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('answers with the session, and remembers who it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, SESSION)));
    const session = await (await freshEnsureSession())();
    expect(session?.user.id).toBe('u1');
    expect(rememberedSession()).toEqual({ user: USER });
  });

  it('carries on as the remembered user when the request never arrives', async () => {
    rememberSession(USER);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const session = await (await freshEnsureSession())();
    expect(session).toEqual({ user: USER });
    expect(rememberedSession()).toEqual({ user: USER });
  });

  it('carries on as the remembered user when the server cannot check', async () => {
    rememberSession(USER);
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: 'Try again shortly.' })));
    expect(await (await freshEnsureSession())()).toEqual({ user: USER });
  });

  it('signs out, and forgets, on a 401', async () => {
    rememberSession(USER);
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { message: 'Unauthorized' })));
    expect(await (await freshEnsureSession())()).toBeNull();
    expect(rememberedSession()).toBeNull();
  });

  it('signs out, and forgets, when the server says there is nobody', async () => {
    rememberSession(USER);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, null)));
    expect(await (await freshEnsureSession())()).toBeNull();
    expect(rememberedSession()).toBeNull();
  });

  it('has nobody to carry on as on a device that never remembered anyone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await (await freshEnsureSession())()).toBeNull();
  });

  describe('the notes kept for reading offline', () => {
    const deleted = vi.fn(async (_name: string) => true);
    beforeEach(() => {
      deleted.mockClear();
      vi.stubGlobal('caches', { delete: deleted });
    });

    it('are emptied when a different person signs in on this device', async () => {
      rememberSession({ id: 'someone-else', email: 'else@example.com' });
      vi.stubGlobal('fetch', vi.fn(async () => json(200, SESSION)));
      await (await freshEnsureSession())();
      expect(deleted.mock.calls.map(([name]) => name).sort()).toEqual(['api-v1', 'files-v1']);
    });

    it('are emptied on the first sign-in after nobody was remembered', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(200, SESSION)));
      await (await freshEnsureSession())();
      expect(deleted.mock.calls.map(([name]) => name).sort()).toEqual(['api-v1', 'files-v1']);
    });

    it('are kept when the same person comes back', async () => {
      rememberSession(USER);
      vi.stubGlobal('fetch', vi.fn(async () => json(200, SESSION)));
      await (await freshEnsureSession())();
      expect(deleted).not.toHaveBeenCalled();
    });

    it('are emptied when the server refuses the session', async () => {
      rememberSession(USER);
      vi.stubGlobal('fetch', vi.fn(async () => json(401, { message: 'Unauthorized' })));
      await (await freshEnsureSession())();
      expect(deleted).toHaveBeenCalledTimes(2);
    });

    it('are kept when the server could not be asked', async () => {
      rememberSession(USER);
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
      await (await freshEnsureSession())();
      expect(deleted).not.toHaveBeenCalled();
    });
  });

  /*
     Airplane mode: the browser says there is no network before any request is made, and
     on Android the request then hangs rather than failing. Waiting for it — even for the
     timeout — is a blank page at launch, so a remembered user is answered at once.
  */
  it('does not wait for the check when the browser already says it is offline', async () => {
    rememberSession(USER);
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const ensureSession = await freshEnsureSession();
    const answer = await Promise.race([
      ensureSession(),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 200)),
    ]);
    expect(answer).toEqual({ user: USER });
  });

  /*
     A cold start offline leaves the store holding the network error from then. Once the
     connection is back, a navigation must not read that old error as news — it put the
     app back offline on every page change — and the app must ask again by itself.
  */
  describe('after a cold start offline', () => {
    async function freshGraph() {
      vi.resetModules();
      return {
        auth: await import('./auth-client.js'),
        connectivity: await import('./connectivity.js'),
      };
    }

    it('does not take the old error for a new one on the next navigation', async () => {
      rememberSession(USER);
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
      const { auth, connectivity } = await freshGraph();
      await auth.ensureSession();
      expect(connectivity.offlineNow()).toBe(true);

      connectivity.reportReachable();
      expect(await auth.ensureSession()).toEqual({ user: USER });
      expect(connectivity.offlineNow()).toBe(false);
    });

    it('asks for the session again when the connection comes back', async () => {
      rememberSession(USER);
      const fetch = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')) as Promise<Response>);
      vi.stubGlobal('fetch', fetch);
      const { auth, connectivity } = await freshGraph();
      auth.installSessionRecheck();
      await auth.ensureSession();
      expect(connectivity.offlineNow()).toBe(true);

      fetch.mockImplementation(async () => json(200, SESSION));
      connectivity.reportReachable();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      const session = await auth.ensureSession();
      expect(session?.user.id).toBe('u1');
      expect(auth.sessionCheckAbandoned()).toBe(false);
    });
  });

  /*
     A sign-out made offline is finished the next time the server can be asked — but only
     for the session it was meant for. Someone who signed in again since, a Google redirect
     included, has a new session and must not be signed out on arrival.
  */
  describe('a sign-out made offline', () => {
    it('answers nobody while there is still no network, without asking', async () => {
      markSignOutPending('s1');
      vi.stubGlobal('navigator', { ...navigator, onLine: false });
      const fetch = vi.fn(async () => json(200, SESSION));
      vi.stubGlobal('fetch', fetch);
      expect(await (await freshEnsureSession())()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('ends that session once the server can be asked', async () => {
      markSignOutPending('s1');
      rememberSession(USER);
      const fetch = vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/sign-out') ? json(200, { success: true }) : json(200, SESSION),
      );
      vi.stubGlobal('fetch', fetch);
      expect(await (await freshEnsureSession())()).toBeNull();
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/sign-out'))).toBe(true);
      expect(pendingSignOut()).toBeNull();
      expect(rememberedSession()).toBeNull();
    });

    it('leaves a newer session alone and forgets the old one', async () => {
      markSignOutPending('an-older-session');
      const fetch = vi.fn(async (_input: RequestInfo | URL) => json(200, SESSION));
      vi.stubGlobal('fetch', fetch);
      const session = await (await freshEnsureSession())();
      expect(session?.user.id).toBe('u1');
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/sign-out'))).toBe(false);
      expect(pendingSignOut()).toBeNull();
    });
  });

  it('stops waiting on a check that hangs', async () => {
    rememberSession(USER);
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const ensureSession = await freshEnsureSession();
    const answer = ensureSession();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await answer).toEqual({ user: USER });
  });
});
