import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { onAppError } from '../app.js';
import type { AppEnv } from '../types.js';
import { notes } from './notes.js';

/**
 * The 402 a client gets when the account's store has no room for a note write (MAK-234),
 * through the route: the store's refusal crosses RPC as a plain error, the facade
 * rebuilds it, the route lets it through, and the app's error handler answers with the
 * upload refusal's shape and `of: 'notes'`. The store tests stop at the RPC error and
 * `store-client.test.ts` at the translation; this is the one place the status is seen.
 */

/** A store whose every note write is refused for room, as the object throws it. */
function fakeEnv() {
  const refusal = () =>
    Promise.reject(Object.assign(new Error('the store holds 2000 bytes, past the 1000 its plan allows'), { name: 'StoreFull', code: 'STORAGE_FULL', of: 'notes', usedBytes: 2000, quotaBytes: 1000 }));
  const store = { update: refusal, createOrFind: refusal };
  return { USER_STORE: { idFromName: (name: string) => name, get: () => store } } as unknown as AppEnv['Bindings'];
}

function app() {
  return new Hono<AppEnv>()
    .onError(onAppError)
    .use(async (c, next) => {
      c.set('userId', 'u1');
      await next();
    })
    .route('/api', notes);
}

describe('a note write the store has no room for', () => {
  it('is a 402 with the storage code, the store named, and the numbers', async () => {
    const env = fakeEnv();
    const saved = await app().request('/api/notes/n1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Longer' }) }, env);
    expect(saved.status).toBe(402);
    expect(await saved.json()).toEqual({
      code: 'STORAGE_FULL',
      of: 'notes',
      usedBytes: 2000,
      quotaBytes: 1000,
      error: expect.stringContaining('notes take more room than its plan allows'),
    });
    const made = await app().request('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New', body: '', tags: [] }) }, env);
    expect(made.status).toBe(402);
    expect(((await made.json()) as { of: string }).of).toBe('notes');
  });
});
