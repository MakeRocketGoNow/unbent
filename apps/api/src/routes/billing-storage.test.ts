import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { GB } from '@unbent/shared';
import type { PlanRow } from '../lib/plan.js';
import type { AppEnv } from '../types.js';

/**
 * The refusals `POST /billing/storage` makes before Paddle hears of a change: less
 * storage than the account's files take, and, since the store's limit follows the quota
 * (MAK-234), less than its store would be allowed. Both from one read of the store
 * (`usage`), and both before the subscription is touched, so a press on the Plan page
 * cannot leave the account refusing every write for a reason it was not shown.
 *
 * The live suite drives the subscription itself through signed webhooks but cannot fill
 * a store past a gigabyte and a half; this is where the store's refusal is seen.
 */
vi.mock('../lib/plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/plan.js')>()),
  planFor: async (): Promise<PlanRow> => ({
    userId: 'u1',
    plan: 'active',
    planUntil: Date.now() + 86_400_000,
    storageGb: 35,
    source: 'paddle',
    paddleCustomerId: 'ctm_1',
    paddleSubscriptionId: 'sub_1',
    paddleStatus: 'active',
    paddleCancelsAt: null,
    paddleEventAt: null,
    lapseNotifiedAt: null,
    createdAt: 0,
    updatedAt: 0,
  }),
}));

/** Paddle is not reached: the change it would be asked for is answered as made. */
vi.mock('../lib/paddle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/paddle.js')>()),
  setSubscriptionStorage: async () => ({ status: 'active' }),
}));

const { billing } = await import('./billing.js');

/** An instance that sells a plan, over a store holding `attachmentBytes` of files and `databaseSize` of itself. */
function env(held: { attachmentBytes: number; databaseSize: number }) {
  const store = { usage: async () => ({ ...held, notes: 1, lastWriteAt: null, wiped: false }) };
  return {
    PADDLE_API_KEY: 'pdl_sdbx_apikey_test',
    PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_test',
    PADDLE_CLIENT_TOKEN: 'test_token',
    PADDLE_PLAN_PRICE_ID: 'pri_plan',
    PADDLE_STORAGE_PRICE_ID: 'pri_storage',
    USER_STORE: { idFromName: (name: string) => name, get: () => store },
  } as unknown as AppEnv['Bindings'];
}

function app() {
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set('userId', 'u1');
      await next();
    })
    .route('/api', billing);
}

const remove = (bindings: AppEnv['Bindings']) =>
  app().request('/api/billing/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storage: 0 }) }, bindings);

describe('removing a storage block', () => {
  it('is refused while the files would not fit the smaller quota', async () => {
    const res = await remove(env({ attachmentBytes: 12 * GB, databaseSize: 100 * 1024 * 1024 }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('This account holds 12.0 GB, more than the 10 GB it would have. Delete some files first.');
  });

  it('is refused while the store would be over the smaller limit, naming the notes', async () => {
    // Under 35 GB the store may take 4 GB; under 10 GB, 1.5 GB. Three gigabytes fits the
    // one and not the other.
    const res = await remove(env({ attachmentBytes: 2 * GB, databaseSize: 3 * GB }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "This account's notes take 3.0 GB of room, more than the 1.5 GB they would have. Delete some notes or clear their history, or empty the trash, first.",
    );
  });

  it('goes on to Paddle once both fit', async () => {
    const res = await remove(env({ attachmentBytes: 2 * GB, databaseSize: GB }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'active', storageGb: 10 });
  });
});
