import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.js';
import { admin } from './admin.js';

/**
 * The operator's feedback routes on a stubbed D1: who may read them, and what the
 * dismiss answers. The statements themselves run against SQLite in
 * `lib/assistant-feedback.test.ts`.
 */

const OPERATOR = { id: 'op1', email: 'operator@example.com' };

const ROW = {
  id: 7,
  user_id: 'u1',
  email: 'u1@example.com',
  client_id: 'client-1',
  client_name: 'Example Assistant',
  category: 'tool-result',
  tool: 'list_notes',
  body: 'The compact list left out the notebook.',
  created_at: 1_790_000_000_000,
};

function fakeEnv() {
  const updates: unknown[][] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: sql.includes('FROM assistant_feedback') ? [ROW] : [] }),
        run: async () => {
          updates.push(args);
          return { meta: { changes: args[0] === ROW.id ? 1 : 0 } };
        },
      }),
    }),
  };
  return { env: { OPERATOR_EMAILS: OPERATOR.email, APP_URL: 'https://notes.example.com', DB } as unknown as AppEnv['Bindings'], updates };
}

function app(user: { id: string; email: string } = OPERATOR) {
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set('userId', user.id);
      c.set('user', user as never);
      await next();
    })
    .route('/api', admin);
}

const dismiss = (env: AppEnv['Bindings'], id: string | number, read: boolean, user?: { id: string; email: string }) =>
  app(user).request(`/api/admin/feedback/${id}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read }) }, env);

describe('the operator feedback routes', () => {
  it('lists the unread feedback with the account and client, and logs the read', async () => {
    const { env } = fakeEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await app().request('/api/admin/feedback', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      feedback: [
        {
          id: 7,
          userId: 'u1',
          email: 'u1@example.com',
          clientId: 'client-1',
          clientName: 'Example Assistant',
          category: 'tool-result',
          tool: 'list_notes',
          body: ROW.body,
          createdAt: ROW.created_at,
        },
      ],
      more: false,
    });
    expect(log).toHaveBeenCalledWith('[store] operator=operator@example.com feedback');
    log.mockRestore();
  });

  it('dismisses a row and brings it back, and answers 404 for one that is not there', async () => {
    const { env, updates } = fakeEnv();
    expect((await dismiss(env, 7, true)).status).toBe(204);
    expect(updates[0]![0]).toBe(7);
    expect(updates[0]![1]).toEqual(expect.any(Number));
    expect((await dismiss(env, 7, false)).status).toBe(204);
    expect(updates[1]).toEqual([7, null]);
    expect((await dismiss(env, 8, true)).status).toBe(404);
    expect((await dismiss(env, 'x', true)).status).toBe(404);
  });

  it('answers anyone else as if the routes did not exist', async () => {
    const { env, updates } = fakeEnv();
    const someone = { id: 'u1', email: 'u1@example.com' };
    expect((await app(someone).request('/api/admin/feedback', {}, env)).status).toBe(404);
    expect((await dismiss(env, 7, true, someone)).status).toBe(404);
    expect(updates).toEqual([]);
  });
});
