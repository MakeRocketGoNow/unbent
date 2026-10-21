import { describe, expect, it, vi } from 'vitest';
import type { Env } from './types.js';

/**
 * A session check that never answers: the shape of the 2026-10-13 stall. Mocked the way
 * `lib/session.test.ts` does it, since the real `getAuth` wants a D1 binding.
 */
const getSession = vi.fn(() => new Promise<never>(() => {}));
vi.mock('./auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));

const { app } = await import('./app.js');

/**
 * Health is exempt from the session check by its position in app.ts, registered before
 * the middleware, which Hono applies only to routes registered after it. Nothing but
 * this test fails if someone moves it back into the chain, or adds a middleware above
 * it that waits on the session; the web app would then read a stalled auth store as the
 * device being offline, which is the bug the placement fixed.
 */
describe('GET /api/health', () => {
  it('answers without waiting on a session check that never settles', async () => {
    const DB = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
    const env = { APP_URL: 'https://example.com', DB } as unknown as Env;
    const res = await app.request('/api/health', { headers: { cookie: 'better-auth.session_token=x' } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', db: 'ok' });
    expect(getSession).not.toHaveBeenCalled();
  });
});

/**
 * Every answer states the deploy's compatibility level, which is how a page still open
 * on an older build learns from its next request that it needs a reload (`COMPAT_HEADER`
 * in `@unbent/shared/compat`, read by `request()` in the web app).
 */
describe('the compatibility header', () => {
  it('is on every answer, health and errors included', async () => {
    const { COMPAT_HEADER, COMPAT_LEVEL } = await import('@unbent/shared/compat');
    const DB = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
    const env = { APP_URL: 'https://example.com', DB } as unknown as Env;
    const health = await app.request('/api/health', {}, env);
    expect(health.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_LEVEL));
    getSession.mockResolvedValueOnce(null as never);
    const missing = await app.request('/api/no-such-route', {}, env);
    expect(missing.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_LEVEL));
  });
});
