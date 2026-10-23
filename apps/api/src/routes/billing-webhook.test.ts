import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanRow } from '../lib/plan.js';
import { signWebhook } from '../lib/stripe.js';
import type { AppEnv } from '../types.js';

/**
 * The webhook's half of a refund, and the other open checkouts a new subscription ends:
 * the places the Worker acts on Stripe from an event. For a refund,
 * `billing-events.test.ts` decides the effect from an invoice it is handed; this is the
 * route that finds that invoice (a dispute's charge for its customer, the charge's
 * payment intent, its invoice payments, the invoice), makes the call the effect asks
 * for, and records the event only once Stripe has agreed. The live suite cannot reach
 * it: it has no Stripe to answer the reads.
 *
 * Stripe is a stand-in answering by path, and D1 a fake that records what is run.
 */

const ROW: PlanRow = {
  userId: 'u1',
  plan: 'active',
  planUntil: Date.now() + 300 * 86_400_000,
  storageGb: 35,
  source: 'stripe',
  customerId: 'cus_1',
  subscriptionId: 'sub_1',
  subscriptionStatus: 'active',
  cancelsAt: null,
  eventAt: null,
  lapseNotifiedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

vi.mock('../lib/plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/plan.js')>()),
  planRowByCustomer: async (_db: unknown, customerId: string) => (customerId === 'cus_1' ? ROW : null),
}));

const { billing } = await import('./billing.js');

const SECRET = 'whsec_test';

/** An invoice of the subscription, billing `lines`. */
function invoice(lines: Array<{ price: string; amount: number; quantity?: number }>) {
  return {
    id: 'in_1',
    customer: 'cus_1',
    status: 'paid',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
    lines: { data: lines.map((l, i) => ({ id: `il_${i}`, amount: l.amount, quantity: l.quantity ?? 1, pricing: { price_details: { price: l.price } }, taxes: [], period: { start: 0, end: 0 } })), has_more: false },
  };
}
const PLAN_AND_STORAGE = invoice([
  { price: 'price_plan', amount: 6000 },
  { price: 'price_storage', amount: 2400 },
]);
const SUBSCRIPTION = {
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  created: 1,
  cancel_at: null,
  cancel_at_period_end: false,
  canceled_at: null,
  metadata: {},
  items: { data: [{ id: 'si_storage', price: { id: 'price_storage' }, quantity: 2, current_period_start: 0, current_period_end: 0 }], has_more: false },
};

/** Stripe answering by method and path; `refuse` names a call to answer 500 instead. */
function stripeStandIn(inv: ReturnType<typeof invoice>, refuse?: string, sent: string[] = []) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const call = `${init.method} ${pathname}`;
    calls.push(call);
    if (init.body) sent.push(decodeURIComponent(String(init.body)));
    if (call === refuse) return Response.json({ error: { type: 'api_error', message: 'Something went wrong.' } }, { status: 500 });
    if (call === 'GET /v1/charges/ch_1') return Response.json({ id: 'ch_1', amount: 8400, amount_refunded: 0, refunded: false, payment_intent: 'pi_1', customer: 'cus_1' });
    if (call === 'GET /v1/invoice_payments') return Response.json({ data: [{ invoice: 'in_1' }], has_more: false });
    if (call === 'GET /v1/invoices/in_1') return Response.json(inv);
    if (call === 'GET /v1/subscriptions/sub_1') return Response.json(SUBSCRIPTION);
    if (call === 'DELETE /v1/subscriptions/sub_1') return Response.json({ ...SUBSCRIPTION, status: 'canceled' });
    if (call === 'POST /v1/subscriptions/sub_1') return Response.json({ ...SUBSCRIPTION, items: { data: [], has_more: false } });
    if (call === 'GET /v1/checkout/sessions') return Response.json({ data: [{ id: 'cs_twin', url: null }], has_more: false });
    if (call === 'POST /v1/checkout/sessions/cs_twin/expire') return Response.json({ id: 'cs_twin', url: null });
    return Response.json({ error: { message: `no stand-in for ${call}` } }, { status: 404 });
  });
  return calls;
}

/** D1, recording what is written: the event's own row and the plan's change. */
function db() {
  const written: string[] = [];
  const statement = (sql: string) => ({
    sql,
    bind: () => ({
      sql,
      first: async () => null,
      run: async () => {
        written.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        return { meta: { changes: 1 } };
      },
    }),
  });
  return {
    written,
    DB: {
      prepare: statement,
      batch: async (stmts: Array<{ sql: string }>) => {
        for (const s of stmts) written.push(s.sql.trim().split(/\s+/).slice(0, 3).join(' '));
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    },
  };
}

async function deliver(event: { type: string; object: Record<string, unknown> }, d: ReturnType<typeof db>) {
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: `evt_${event.type}`, type: event.type, created, data: { object: event.object } });
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PLAN_PRICE_ID: 'price_plan',
    STRIPE_STORAGE_PRICE_ID: 'price_storage',
    // Loopback with no address is let through only with this on: the webhook's source check is `stripe.test.ts`'s.
    ALLOW_TEST_CREDENTIALS: '1',
    DB: d.DB,
  } as unknown as AppEnv['Bindings'];
  const app = new Hono<AppEnv>().route('/api', billing);
  const res = await app.request(
    '/api/billing/webhook',
    { method: 'POST', headers: { 'stripe-signature': await signWebhook(SECRET, body, created) }, body },
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const refund = (amountRefunded: number) => ({
  type: 'charge.refunded',
  object: { id: 'ch_1', amount: 8400, amount_refunded: amountRefunded, refunded: amountRefunded >= 8400, payment_intent: 'pi_1', customer: 'cus_1' },
});

afterEach(() => vi.unstubAllGlobals());

describe('the webhook on a refund', () => {
  it('reads a dispute\'s charge for its customer, finds the invoice through the payment, and cancels', async () => {
    const calls = stripeStandIn(PLAN_AND_STORAGE);
    const d = db();
    const res = await deliver({ type: 'charge.dispute.created', object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 100, status: 'needs_response' } }, d);
    expect(res).toEqual({ status: 200, body: { applied: true } });
    expect(calls).toEqual(['GET /v1/charges/ch_1', 'GET /v1/invoice_payments', 'GET /v1/invoices/in_1', 'DELETE /v1/subscriptions/sub_1']);
    expect(d.written).toEqual(['INSERT OR IGNORE', 'UPDATE account_plan SET']);
  });

  it('cancels for a refund of the whole charge', async () => {
    const calls = stripeStandIn(PLAN_AND_STORAGE);
    const d = db();
    expect((await deliver(refund(8400), d)).body).toEqual({ applied: true });
    expect(calls.at(-1)).toBe('DELETE /v1/subscriptions/sub_1');
  });

  it("takes the add-on off, charging nothing, for a refund of no more than the add-on's lines", async () => {
    const calls = stripeStandIn(PLAN_AND_STORAGE);
    const d = db();
    expect((await deliver(refund(2400), d)).body).toEqual({ applied: true });
    expect(calls.slice(-2)).toEqual(['GET /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1']);
    expect(calls).not.toContain('DELETE /v1/subscriptions/sub_1');
  });

  /** A storage block bought mid-year is invoiced on its own; refunding it takes that block off and keeps the two before it. */
  it('takes off only the block a refunded storage invoice added', async () => {
    const thirdBlock = invoice([
      { price: 'price_storage', amount: 3600, quantity: 3 },
      { price: 'price_storage', amount: -2400, quantity: 2 },
    ]);
    const sent: string[] = [];
    stripeStandIn(thirdBlock, undefined, sent);
    // The subscription as Stripe has it after the purchase: three blocks.
    const three = { ...SUBSCRIPTION, items: { data: [{ ...SUBSCRIPTION.items.data[0]!, quantity: 3 }], has_more: false } };
    const fetchWithThree = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
      init.method === 'GET' && new URL(url).pathname === '/v1/subscriptions/sub_1' ? Response.json(three) : fetchWithThree(url, init),
    );
    const d = db();
    expect((await deliver({ ...refund(1200), object: { ...refund(1200).object, amount: 1200, refunded: true } }, d)).body).toEqual({ applied: true });
    expect(sent.at(-1)).toContain('items[0][quantity]=2');
  });

  /** Recorded only once Stripe has agreed: an event written down here would never be delivered again, and the subscription would renew. */
  it('answers 502 and records nothing when Stripe refuses the cancel, so the refund is delivered again', async () => {
    stripeStandIn(PLAN_AND_STORAGE, 'DELETE /v1/subscriptions/sub_1');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = db();
    const res = await deliver(refund(8400), d);
    quiet.mockRestore();
    expect(res.status).toBe(502);
    expect(d.written).toEqual([]);
  });
});

describe('the webhook on a new subscription', () => {
  /** Two presses at the same moment each open a session; once one is paid, the other must not stay payable. */
  it("ends the customer's other open checkouts before applying the subscription", async () => {
    const calls = stripeStandIn(PLAN_AND_STORAGE);
    const d = db();
    const res = await deliver({ type: 'customer.subscription.created', object: SUBSCRIPTION }, d);
    expect(res).toEqual({ status: 200, body: { applied: true } });
    expect(calls).toEqual(['GET /v1/checkout/sessions', 'POST /v1/checkout/sessions/cs_twin/expire']);
    expect(d.written).toEqual(['INSERT OR IGNORE', 'UPDATE account_plan SET']);
  });

  it('leaves open checkouts alone on any other subscription event', async () => {
    const calls = stripeStandIn(PLAN_AND_STORAGE);
    await deliver({ type: 'customer.subscription.updated', object: SUBSCRIPTION }, db());
    expect(calls).toEqual([]);
  });

  /** Recorded only once the sessions are ended: an event written down here would never be delivered again, and the twin would stay payable. */
  it('answers 502 and records nothing when Stripe refuses the list, so the event is delivered again', async () => {
    stripeStandIn(PLAN_AND_STORAGE, 'GET /v1/checkout/sessions');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = db();
    const res = await deliver({ type: 'customer.subscription.created', object: SUBSCRIPTION }, d);
    quiet.mockRestore();
    expect(res.status).toBe(502);
    expect(d.written).toEqual([]);
  });
});
