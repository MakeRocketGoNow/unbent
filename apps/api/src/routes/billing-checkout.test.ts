import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanRow } from '../lib/plan.js';
import type { AppEnv } from '../types.js';

/**
 * `POST /billing/checkout` for an account whose row has a customer and no subscription:
 * the lag between a paid checkout and its webhook, where the row alone would let a second
 * checkout through. Stripe is a stand-in answering by path; D1 is never reached, since
 * the row is the mocked `planFor`'s and the customer already on it.
 */
vi.mock('../lib/plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/plan.js')>()),
  planFor: async (): Promise<PlanRow> => ({
    userId: 'u1',
    plan: 'trial',
    planUntil: Date.now() + 10 * 86_400_000,
    storageGb: 10,
    source: null,
    customerId: 'cus_1',
    subscriptionId: null,
    subscriptionStatus: null,
    cancelsAt: null,
    eventAt: null,
    lapseNotifiedAt: null,
    createdAt: 0,
    updatedAt: 0,
  }),
}));

const { billing } = await import('./billing.js');

function stripeStandIn(subscriptions: Array<{ id: string; status: string; created: number }>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    calls.push(`${init.method} ${pathname}`);
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

describe('starting a checkout', () => {
  it('refuses a second one while the first checkout’s subscription has not reached the row', async () => {
    const calls = stripeStandIn([{ id: 'sub_new', status: 'active', created: 2 }]);
    expect(await press()).toBe(409);
    // Open sessions first, then the live-subscription check: a payment that completed
    // while those were being closed still refuses, and no new session is made.
    expect(calls).toEqual(['GET /v1/checkout/sessions', 'GET /v1/subscriptions']);
  });

  it('refuses while an older subscription is live behind a newer one that has ended', async () => {
    stripeStandIn([
      { id: 'sub_dup', status: 'active', created: 1 },
      { id: 'sub_new', status: 'canceled', created: 2 },
    ]);
    expect(await press()).toBe(409);
  });

  it('opens one for a customer whose subscriptions have all ended', async () => {
    const calls = stripeStandIn([{ id: 'sub_old', status: 'canceled', created: 1 }]);
    expect(await press()).toBe(200);
    expect(calls).toEqual(['GET /v1/checkout/sessions', 'GET /v1/subscriptions', 'POST /v1/checkout/sessions']);
  });
});
