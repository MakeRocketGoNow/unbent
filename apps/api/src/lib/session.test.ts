import { APIError } from 'better-auth/api';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, Env } from '../types.js';

/**
 * `sessionMiddleware` reaches for `getAuth` from `../auth.js`, whose real implementation
 * constructs Better Auth against a D1 binding these tests do not have. Mock it so each case
 * can decide what `getSession` does — resolve a user, resolve null, or throw — without a
 * database.
 */
const getSession = vi.fn();
vi.mock('../auth.js', () => ({
  getAuth: () => ({ api: { getSession } }),
}));

// Imported after the mock is registered, so the middleware closes over the stub.
const { sessionMiddleware, requireAuth, SESSION_CHECK_MS, whoAmI } = await import('./session.js');

/** Only the shape the middleware hands to `getAuth`; the bindings are never touched here. */
const env = { APP_URL: 'https://example.com' } as unknown as Env;

/**
 * A minimal stack mirroring index.ts: the global error handler that turns an uncaught throw
 * into the 500 we saw in production, the session middleware under test, and a public and a
 * protected route to observe what each does when the session cannot be resolved.
 */
function app() {
  const a = new Hono<AppEnv>();
  a.onError((_err, c) => c.json({ error: 'Internal error' }, 500));
  a.use('*', sessionMiddleware);
  a.get('/public', (c) => c.json({ userId: c.get('userId') ?? null }));
  a.get('/me', whoAmI);
  a.get('/protected', requireAuth, (c) => c.json({ userId: c.get('userId') }));
  return a;
}

function call(path: string) {
  return app().request(path, {}, env);
}

afterEach(() => {
  getSession.mockReset();
  vi.useRealTimers();
});

describe('sessionMiddleware', () => {
  it('puts the user on the context when a session resolves', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A', image: null } });
    const res = await call('/public');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'u1' });
  });

  it('leaves the request unauthenticated when there is no session', async () => {
    getSession.mockResolvedValue(null);
    const res = await call('/public');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: null });
  });

  /**
   * The production failure this guards against: `getSession` reads D1, and a transient read
   * blip made it throw. Unhandled, that escaped to the global handler as a 500 on every
   * route — including the unauthenticated health check, which read as the whole API being
   * down. A failure to resolve a session must degrade to no session, never a 500.
   */
  it('does not turn a getSession failure into a 500 on a public route', async () => {
    getSession.mockRejectedValue(new Error('D1_ERROR: Network connection lost'));
    const res = await call('/public');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: null });
  });

  /**
   * A protected route still refuses, but says the session could not be checked rather than
   * that there is none: a 401 signs every client out, and the phone deletes its queued
   * shares on one. The database refusing reads — a quota run out — must not do that.
   */
  it('answers a protected route 503 with Retry-After, not 401 or 500, when getSession fails', async () => {
    getSession.mockRejectedValue(new Error('D1_ERROR: Network connection lost'));
    const res = await call('/protected');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  /**
   * Better Auth wraps its own store failing as a 500 `APIError`, so that is the shape a D1
   * refusal really arrives in — not only the raw error above.
   */
  it('answers 503 when Better Auth reports its store failed', async () => {
    getSession.mockRejectedValue(new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to get session' }));
    const res = await call('/protected');
    expect(res.status).toBe(503);
  });

  /**
   * A 4xx from Better Auth is about this client's session, and would fail the same way on
   * every retry. A 503 there would leave the client retrying forever with no route back to
   * sign-in, so it is answered as no session.
   */
  it('answers 401, not 503, when Better Auth rejects the session itself', async () => {
    getSession.mockRejectedValue(new APIError('UNAUTHORIZED', { message: 'Failed to get session' }));
    const res = await call('/protected');
    expect(res.status).toBe(401);
  });

  /*
     A session check that never answers held every request carrying one person's cookie
     for minutes (2026-10-13). Past the bound the request goes on: a public route answers,
     a protected one asks the client to retry, and neither waits for the browser to give up.
   */
  it('gives up on a session check that never answers, and answers the request anyway', async () => {
    vi.useFakeTimers();
    getSession.mockImplementation(() => new Promise(() => {}));
    const pub = call('/public');
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS);
    const res = await pub;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: null });
    const prot = call('/protected');
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS);
    const refused = await prot;
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBe('60');
  });

  it('still answers 401 when there is simply no session', async () => {
    getSession.mockResolvedValue(null);
    const res = await call('/protected');
    expect(res.status).toBe(401);
  });
});

describe('whoAmI', () => {
  it('returns the user when a session resolves', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A', image: null } });
    const res = await call('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: 'u1', email: 'a@b.c', name: 'A', image: null, legalVersion: null },
    });
  });

  it('returns null rather than 401 when there is no session', async () => {
    getSession.mockResolvedValue(null);
    const res = await call('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it('returns null, not 503, when Better Auth rejects the session itself', async () => {
    getSession.mockRejectedValue(new APIError('UNAUTHORIZED', { message: 'Failed to get session' }));
    const res = await call('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  /**
   * The phones treat 200 with no user as a real sign-out: they clear the stored session
   * and drop queued shares. A lookup that timed out is not that — it is the same failure
   * `requireAuth` answers 503 for — and must not look like nobody is signed in.
   */
  it('answers 503 with Retry-After, not 200 with no user, when the session check never answers', async () => {
    vi.useFakeTimers();
    getSession.mockImplementation(() => new Promise(() => {}));
    const pending = call('/me');
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).not.toEqual({ user: null });
  });

  it('answers 503 when the session store fails', async () => {
    getSession.mockRejectedValue(new Error('D1_ERROR: Network connection lost'));
    const res = await call('/me');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
  });
});
