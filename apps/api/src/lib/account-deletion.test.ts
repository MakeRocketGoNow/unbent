import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteAccount } from './account-deletion.js';

/**
 * The operator's delete, against fakes that record the order things happen in. Over
 * HTTP the suites cannot reach it (none of their actors is an operator) and the order
 * is the point: files and store before the row, so a failure leaves an account that can
 * be deleted again rather than files nothing can name.
 */

function fakeEnv(fail?: 'blobs' | 'wipe', plan?: Record<string, unknown>) {
  const steps: string[] = [];
  const env = {
    ...(plan
      ? { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PLAN_PRICE_ID: 'price_plan', STRIPE_STORAGE_PRICE_ID: 'price_storage' }
      : {}),
    BLOBS: {
      async list() {
        if (fail === 'blobs') throw new Error('R2 is down');
        steps.push('list');
        return { objects: [{ key: 'users/u1/a.pdf' }], truncated: false };
      },
      async delete() {
        steps.push('blobs');
      },
    },
    USER_STORE: {
      idFromName: (name: string) => name,
      get: () => ({
        async wipe() {
          if (fail === 'wipe') throw new Error('object reset');
          steps.push('wipe');
        },
      }),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          async first() {
            return plan ?? null;
          },
          async run() {
            if (sql.includes('account_plan')) steps.push(`plan ${args.filter((a) => typeof a === 'string' && a.startsWith('sub_')).join(' ')}`);
            else steps.push(sql.startsWith('DELETE FROM user') ? `user ${String(args[0])}` : 'tombstone');
          },
        }),
      }),
    },
  };
  return { env: env as unknown as Parameters<typeof deleteAccount>[0], steps };
}

describe('deleteAccount', () => {
  it('deletes the files, then the store, then the row, then tombstones the directory', async () => {
    const { env, steps } = fakeEnv();
    await deleteAccount(env, 'u1');
    expect(steps).toEqual(['list', 'blobs', 'wipe', 'user u1', 'tombstone']);
  });

  it.each(['blobs', 'wipe'] as const)('keeps the account when the %s step fails', async (step) => {
    const { env, steps } = fakeEnv(step);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deleteAccount(env, 'u1')).rejects.toThrow();
    quiet.mockRestore();
    expect(steps.some((s) => s.startsWith('user'))).toBe(false);
    expect(steps).not.toContain('tombstone');
  });

  /**
   * A checkout paid a moment ago reaches the row only by webhook. A deletion inside
   * that lag still finds the subscription, from Stripe, and ends it, and ends any
   * checkout still open first, so none is paid for after the account is gone.
   */
  describe('with a plan sold', () => {
    afterEach(() => vi.unstubAllGlobals());
    const row = {
      user_id: 'u1', plan: 'trial', plan_until: 0, storage_gb: 10, source: null, billing_customer_id: 'cus_1',
      billing_subscription_id: null, billing_status: null, billing_cancels_at: null, billing_event_at: null,
      lapse_notified_at: null, created_at: 0, updated_at: 0,
    };
    function stripeAnswers(subscriptions: Array<{ id: string; status: string; created: number }>) {
      const calls: string[] = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname + new URL(url).search;
        calls.push(`${init.method} ${path}`);
        if (path.startsWith('/v1/checkout/sessions?')) return Response.json({ data: [], has_more: false });
        if (path.startsWith('/v1/subscriptions?')) return Response.json({ data: subscriptions, has_more: false });
        return Response.json({ id: 'sub_new', status: 'canceled' });
      });
      return calls;
    }

    it('cancels a subscription the row has not heard of yet', async () => {
      const calls = stripeAnswers([{ id: 'sub_new', status: 'active', created: 2 }]);
      const { env, steps } = fakeEnv(undefined, row);
      await deleteAccount(env, 'u1');
      expect(calls).toEqual([
        'GET /v1/checkout/sessions?customer=cus_1&status=open&limit=100',
        'GET /v1/subscriptions?customer=cus_1&status=all&limit=100',
        'DELETE /v1/subscriptions/sub_new',
      ]);
      expect(steps[0]).toBe('plan sub_new');
      expect(steps).toContain('user u1');
    });

    it('cancels every live subscription the customer holds, not only the newest', async () => {
      const calls = stripeAnswers([
        { id: 'sub_a', status: 'active', created: 1 },
        { id: 'sub_b', status: 'active', created: 2 },
        { id: 'sub_old', status: 'canceled', created: 0 },
      ]);
      const { env } = fakeEnv(undefined, row);
      await deleteAccount(env, 'u1');
      expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /v1/subscriptions/sub_a', 'DELETE /v1/subscriptions/sub_b']);
    });

    it('cancels nothing for a former subscriber whose newest subscription has ended', async () => {
      const calls = stripeAnswers([{ id: 'sub_old', status: 'canceled', created: 1 }]);
      const { env, steps } = fakeEnv(undefined, { ...row, billing_subscription_id: 'sub_old', billing_status: 'canceled' });
      await deleteAccount(env, 'u1');
      expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
      expect(steps.some((s) => s.startsWith('plan'))).toBe(false);
      expect(steps).toContain('user u1');
    });
  });
});
