import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';

/**
 * The session check, mocked as `app.test.ts` mocks it, since the real `getAuth` wants a
 * D1 binding. Nobody is signed in, so a route that gets as far as `requireAuth` says 401.
 */
const getSession = vi.fn(async () => null);
vi.mock('../auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));

const { app } = await import('../app.js');

const post = (env: Partial<Env>) =>
  app.request(
    '/api/clip',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/' }) },
    { APP_URL: 'https://example.com', DB: {}, ...env } as unknown as Env,
  );

/**
 * The clipper is sized for Workers Paid and off until the operator says so (`WEB_CLIP`,
 * `webClipOf`). The live cases are test/clip.test.ts's, against a dev server that has it
 * on; this is the half a dev server cannot show.
 */
describe('POST /api/clip behind WEB_CLIP', () => {
  it('answers 404 with CLIP_OFF where the clipper is off, signed in or not', async () => {
    const res = await post({});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Web clipping is off on this instance', code: 'CLIP_OFF' });
  });

  it('wants a session where it is on', async () => {
    const res = await post({ WEB_CLIP: '1' });
    expect(res.status).toBe(401);
  });
});
