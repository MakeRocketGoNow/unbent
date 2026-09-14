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
const { sessionMiddleware, requireAuth } = await import('./session.js');

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
  a.get('/protected', requireAuth, (c) => c.json({ userId: c.get('userId') }));
  return a;
}

function call(path: string) {
  return app().request(path, {}, env);
}

afterEach(() => {
  getSession.mockReset();
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

  /** A protected route still refuses — but with a recoverable 401, not a 500. */
  it('degrades a protected route to 401 rather than 500 when getSession fails', async () => {
    getSession.mockRejectedValue(new Error('D1_ERROR: Network connection lost'));
    const res = await call('/protected');
    expect(res.status).toBe(401);
  });
});
