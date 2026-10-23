import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanRow } from '../lib/plan.js';
import type { AppEnv } from '../types.js';

/**
 * `POST /billing/checkout` on the first Subscribe: the row has no customer yet, so the
 * customer is created in this request. A twin press that also read a row with none
 * shares that customer (`createCustomer`'s key). The live-subscription check has to
 * run against that id, not the row's, or both presses skip it and the second session
 * stays payable beside a subscription the first tab already paid.
 *
 * Stripe is a stand-in answering by path. `updatePlan` is stubbed so writing the new
 * customer id never reaches D1.
 */
vi.mock('../lib/plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/plan.js')>()),
  planFor: async (): Promise<PlanRow> => ({
    userId: 'u1',
    plan: 'trial',
    planUntil: Date.now() + 10 * 86_400_000,
    storageGb: 10,
    source: null,
    customerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    cancelsAt: null,
    eventAt: null,
    lapseNotifiedAt: null,
    createdAt: 0,
    updatedAt: 0,
  }),
  updatePlan: async () => {},
}));

const { billing } = await import('./billing.js');

function stripeStandIn(subscriptions: Array<{ id: string; status: string; created: number }>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    calls.push(`${init.method} ${pathname}`);
    if (pathname === '/v1/customers') return Response.json({ id: 'cus_1' });
    if (pathname === '/v1/subscriptions') return Response.json({ data: subscriptions, has_more: false });
    if (pathname === '/v1/checkout/sessions' && init.method === 'GET') return Response.json({ data: [], has_more: false });
    if (pathname === '/v1/checkout/sessions') return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    return Response.json({ error: { message: 'no stand-in' } }, { status: 404 });
  });
  return calls;
}

async function press() {
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PLAN_PRICE_ID: 'price_plan',
    STRIPE_STORAGE_PRICE_ID: 'price_storage',
    APP_URL: 'https://unbent.test',
  } as unknown as AppEnv['Bindings'];
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set('userId', 'u1');
      c.set('user', { email: 'jo@example.com' } as never);
      await next();
    })
    .route('/api', billing);
  const res = await app.request('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storage: 0 }) }, env);
  return res.status;
}

afterEach(() => vi.unstubAllGlobals());

describe('starting the first checkout', () => {
  it('refuses once Stripe already has a live subscription for the customer just made', async () => {
    const calls = stripeStandIn([{ id: 'sub_paid', status: 'active', created: 1 }]);
    expect(await press()).toBe(409);
    expect(calls).toEqual(['POST /v1/customers', 'GET /v1/checkout/sessions', 'GET /v1/subscriptions']);
  });

  it('opens one when the customer just made has no subscription yet', async () => {
    const calls = stripeStandIn([]);
    expect(await press()).toBe(200);
    expect(calls).toEqual([
      'POST /v1/customers',
      'GET /v1/checkout/sessions',
      'GET /v1/subscriptions',
      'POST /v1/checkout/sessions',
    ]);
  });
});
