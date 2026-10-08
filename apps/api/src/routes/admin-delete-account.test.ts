import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types.js';
import { admin } from './admin.js';

/**
 * The operator's delete, through the route, on a stubbed env. The live suite in
 * `test/store-ops.test.ts` can only show the refusal a non-operator gets, since none of
 * its actors is an operator; the branches that matter once one is — the operator's own
 * account, a confirmation that names a different account, a deletion already made — are
 * here. `lib/account-deletion.test.ts` has the deletion's own order.
 */

const OPERATOR = { id: 'op1', email: 'operator@example.com' };

/** D1 as far as the route reads it: who is in the directory, who has a `user` row, and every statement run. */
function fakeEnv({ directory = ['op1', 'u1'], users = ['op1', 'u1'] }: { directory?: string[]; users?: string[] } = {}) {
  const ran: string[] = [];
  const wiped: string[] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        async first() {
          const id = String(args[0]);
          if (sql.includes('FROM account_directory')) return directory.includes(id) ? { user_id: id } : null;
          if (sql.includes('FROM user')) return users.includes(id) ? { email: `${id}@example.com` } : null;
          return null;
        },
        async run() {
          ran.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        },
      }),
    }),
  };
  const env = {
    OPERATOR_EMAILS: OPERATOR.email,
    DB,
    BLOBS: { list: async () => ({ objects: [], truncated: false }), delete: async () => {} },
    USER_STORE: { idFromName: (name: string) => name, get: (name: string) => ({ wipe: async () => void wiped.push(name) }) },
  };
  return { env: env as unknown as AppEnv['Bindings'], ran, wiped };
}

/** The admin routes behind a session that is the operator's. */
function app() {
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set('userId', OPERATOR.id);
      c.set('user', OPERATOR as never);
      await next();
    })
    .route('/api', admin);
}

const remove = (env: AppEnv['Bindings'], id: string, confirm?: string) =>
  app().request(`/api/admin/accounts/${id}${confirm === undefined ? '' : `?confirm=${confirm}`}`, { method: 'DELETE' }, env);

describe('DELETE /api/admin/accounts/:id', () => {
  it("deletes the account and logs whose it was before anything goes", async () => {
    const { env, ran, wiped } = fakeEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await remove(env, 'u1', 'u1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 'u1' });
    expect(wiped).toEqual(['u1']);
    expect(ran).toContain('DELETE FROM user');
    expect(log.mock.calls.map((c) => String(c[0]))).toContain('[store] operator=operator@example.com delete user=u1 email=u1@example.com');
    log.mockRestore();
  });

  it.each([
    ['without a confirmation', undefined],
    ['with a confirmation naming another account', 'op1'],
  ])('refuses %s, and deletes nothing', async (_, confirm) => {
    const { env, ran, wiped } = fakeEnv();
    const res = await remove(env, 'u1', confirm);
    expect(res.status).toBe(400);
    expect(wiped).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("refuses the operator's own account, even confirmed", async () => {
    const { env, ran, wiped } = fakeEnv();
    const res = await remove(env, 'op1', 'op1');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('your own account');
    expect(wiped).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('answers 404 for an id the directory does not hold, and for a deletion already made', async () => {
    for (const setup of [{ directory: ['op1'] }, { users: ['op1'] }]) {
      const { env, ran, wiped } = fakeEnv(setup);
      const res = await remove(env, 'u1', 'u1');
      expect(res.status).toBe(404);
      expect(wiped).toEqual([]);
      expect(ran).toEqual([]);
    }
  });

  it('answers a non-operator as if the route did not exist', async () => {
    const { env, wiped } = fakeEnv();
    const res = await remove({ ...env, OPERATOR_EMAILS: '' } as AppEnv['Bindings'], 'u1', 'u1');
    expect(res.status).toBe(404);
    expect(wiped).toEqual([]);
  });
});
