import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { GB, STORE_FLOOR_BYTES } from '@unbent/shared';
import { onAppError } from '../app.js';
import type { WriteLimits } from '../store/user-store.js';
import type { AppEnv } from '../types.js';
import { attachments } from './attachments.js';

/**
 * The browser's text layer and the store's room (MAK-234). The route is exempt from the
 * plan check, so no plan row is on its context, and the limit is read for the write
 * that asks for it. Without that read the text PUT was unbounded, the very loop the
 * bound on file text exists for (found in review).
 */

const stripe = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 's',
  STRIPE_PLAN_PRICE_ID: 'p',
  STRIPE_STORAGE_PRICE_ID: 'q',
};

/** D1 with one plan row on the base storage, and a store that refuses text past any limit it is given. */
function fakeEnv({ billing }: { billing: boolean }) {
  const reads: string[] = [];
  const limits: Array<WriteLimits | null | undefined> = [];
  const row = {
    user_id: 'u1', plan: 'trial', plan_until: Date.now() + 86_400_000, storage_gb: 10, source: null,
    billing_customer_id: null, billing_subscription_id: null, billing_status: null, billing_cancels_at: null,
    billing_event_at: null, lapse_notified_at: null, created_at: 1, updated_at: 1,
  };
  const DB = {
    prepare: (sql: string) => ({
      bind: () => ({
        async first() {
          reads.push(sql);
          return row;
        },
      }),
    }),
  };
  const store = {
    attachmentIdFor: async () => 'a1',
    recordText: async (_input: unknown, _usage: unknown, limit: WriteLimits | null | undefined) => {
      limits.push(limit);
      if (limit?.store != null) {
        throw Object.assign(new Error('the store holds 2000 bytes'), { name: 'StoreFull', code: 'STORAGE_FULL', of: 'notes', usedBytes: limit.store + 1, quotaBytes: limit.store });
      }
    },
  };
  const env = { ...(billing ? stripe : {}), DB, USER_STORE: { idFromName: (name: string) => name, get: () => store } };
  return { env: env as unknown as AppEnv['Bindings'], reads, limits };
}

function app() {
  return new Hono<AppEnv>()
    .onError(onAppError)
    .use(async (c, next) => {
      c.set('userId', 'u1');
      await next();
    })
    .route('/api', attachments);
}

const put = (env: AppEnv['Bindings'], body: unknown) =>
  app().request('/api/notes/n1/files/scan.pdf/text', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);

describe('the text layer and the store limit', () => {
  it('reads the plan for the write and refuses past the limit with the store’s 402', async () => {
    const { env, reads, limits } = fakeEnv({ billing: true });
    const res = await put(env, { text: 'x'.repeat(1000) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'STORAGE_FULL', of: 'notes' });
    // A trial's row: the store's room, and no free plan's limits while the trial holds.
    expect(limits).toEqual([{ store: STORE_FLOOR_BYTES + GB, free: null }]);
    expect(reads).toHaveLength(1);
  });

  it('reads nothing and passes no limit where billing is off', async () => {
    const { env, reads, limits } = fakeEnv({ billing: false });
    const res = await put(env, { text: 'x'.repeat(1000) });
    expect(res.status).toBe(204);
    expect(limits).toEqual([null]);
    expect(reads).toHaveLength(0);
  });
});
