/**
 * The read-only rule for a lapsed account (MAK-108), over HTTP against a live
 * `wrangler dev`: once an account's plan has ended, every write but a delete is a 402,
 * and every read still answers. The rule is global (`requireActivePlan`), so this
 * checks a sample of each kind rather than every route; `plan-middleware.test.ts`
 * holds the whole table.
 *
 * Only where the dev server sells a plan: billing is off without the `STRIPE_*`
 * settings in `.dev.vars`, and then there is nothing to check, which the cases report
 * as skipped. The sandbox's values, or four made-up ones of the right shape, both turn
 * it on; nothing here reaches Stripe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from '../src/lib/stripe.js';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

let cookie = '';
let billing = false;
let noteId = '';

async function signUp(): Promise<string> {
  const email = `plan-${crypto.randomUUID()}@example.test`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password: 'correct horse battery', name: 'Plan' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0]!)
    .join('; ');
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function setPlan(plan: 'trial' | 'active' | 'inactive', until: number | null): Promise<void> {
  const res = await call('POST', '/api/admin/test/plan', { plan, until });
  if (!res.ok) throw new Error(`test plan failed: ${res.status} ${await res.text()}`);
}

beforeAll(async () => {
  cookie = await signUp();
  const config = (await (await fetch(`${BASE}/api/config`)).json()) as { billing?: unknown };
  billing = Boolean(config.billing);
  if (!billing) return;
  const made = await call('POST', '/api/notes', { title: 'Before the plan ended', body: 'still here' });
  noteId = ((await made.json()) as { id: string }).id;
});

afterAll(async () => {
  if (billing) await setPlan('trial', Date.now() + 86_400_000);
});

describe('a lapsed account', () => {
  it('starts on a trial, which the plan reports', async (ctx) => {
    if (!billing) return ctx.skip();
    const plan = (await (await call('GET', '/api/me/plan')).json()) as { state: string; until: number; storageGb: number };
    expect(plan.state).toBe('trial');
    expect(plan.until).toBeGreaterThan(Date.now());
    expect(plan.storageGb).toBe(10);
    // The Plan page's read carries what the store holds against both bounds (MAK-234):
    // the files' bytes against the quota, and the store's own size against its limit,
    // which the page works out from the plan's storage itself.
    const held = (await (await call('GET', '/api/me/plan?usage=1')).json()) as { usedBytes: number; storeBytes: number };
    expect(held.usedBytes).toBe(0);
    expect(held.storeBytes).toBeGreaterThan(0);
  });

  it('is refused every write but a delete once its plan has ended, and still reads', async (ctx) => {
    if (!billing) return ctx.skip();
    await setPlan('trial', Date.now() - 1000);
    expect(((await (await call('GET', '/api/me/plan')).json()) as { state: string }).state).toBe('inactive');

    const refused = await call('POST', '/api/notes', { title: 'x', body: 'y' });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { code: string }).code).toBe('PLAN_INACTIVE');
    expect((await call('PATCH', `/api/notes/${noteId}`, { title: 'renamed' })).status).toBe(402);
    expect((await call('POST', '/api/notebooks', { name: 'Later' })).status).toBe(402);

    expect((await call('GET', '/api/notes')).status).toBe(200);
    expect((await call('GET', `/api/notes/${noteId}`)).status).toBe(200);
    expect((await call('GET', '/api/search?q=here')).status).toBe(200);
    expect((await call('GET', '/api/export/notes')).status).toBe(200);
    expect((await call('GET', '/api/notes/' + noteId + '/export')).status).toBe(200);

    // The one write that is allowed, and its undo.
    expect((await call('DELETE', `/api/notes/${noteId}`)).ok).toBe(true);
    expect((await call('POST', `/api/notes/${noteId}/restore`)).ok).toBe(true);
    expect((await call('POST', '/api/billing/checkout', { storage: 0 })).status).not.toBe(402);
  });

  it('cannot be comped by anyone but an operator', async (ctx) => {
    if (!billing) return ctx.skip();
    const me = ((await (await call('GET', '/api/me')).json()) as { user: { id: string } }).user.id;
    expect((await call('POST', `/api/admin/accounts/${me}/plan`, { action: 'comp', until: null })).status).toBe(404);
  });

  it('writes again once the plan is back', async (ctx) => {
    if (!billing) return ctx.skip();
    await setPlan('active', null);
    expect((await call('PATCH', `/api/notes/${noteId}`, { title: 'renamed' })).status).toBe(200);
    expect(((await (await call('GET', '/api/me/plan')).json()) as { state: string }).state).toBe('active');
  });
});

/**
 * Stripe's webhook, with a body signed the way Stripe signs one. Needs the dev server's
 * own secret, which the suite is given as `STRIPE_WEBHOOK_SECRET`; without it the cases
 * skip, since a signature with any other key is refused by design. The price ids the
 * server holds are given the same way (`STRIPE_PLAN_PRICE_ID`, `STRIPE_STORAGE_PRICE_ID`)
 * once `.dev.vars` carries the sandbox's rather than the stand-ins.
 */
describe('the webhook', () => {
  const secret = process.env['STRIPE_WEBHOOK_SECRET'];
  // The price ids the dev server holds, so an event's items are read as the plan and
  // the add-on; the stand-ins the worktree's `.dev.vars` starts with unless given.
  const PLAN_PRICE = process.env['STRIPE_PLAN_PRICE_ID'] ?? 'price_local_plan';
  const STORAGE_PRICE = process.env['STRIPE_STORAGE_PRICE_ID'] ?? 'price_local_storage';
  const customer = `cus_test_${crypto.randomUUID().slice(0, 8)}`;
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const T0 = seconds('2026-10-10T00:00:00Z');
  const NEXT_YEAR = seconds('2027-10-10T00:00:00Z');

  async function deliver(event: Record<string, unknown>, key = secret ?? 'wrong'): Promise<Response> {
    const body = JSON.stringify(event);
    return fetch(`${BASE}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': await signWebhook(key, body, Math.floor(Date.now() / 1000)) },
      body,
    });
  }
  const envelope = (id: string, type: string, at: string, object: Record<string, unknown>) => ({ id, type, created: seconds(at), data: { object } });

  const item = (price: string, quantity: number) => ({ id: `si_${price}`, price: { id: price }, quantity, current_period_start: T0, current_period_end: NEXT_YEAR });
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_test',
    status: 'active',
    customer,
    created: T0,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: {},
    items: { data: [item(PLAN_PRICE, 1), item(STORAGE_PRICE, 1)], has_more: false },
    ...over,
  });

  it('refuses a body it cannot verify', async (ctx) => {
    if (!billing) return ctx.skip();
    expect((await deliver(envelope('evt_x', 'customer.subscription.created', '2026-10-10T00:00:00Z', subscription()), 'whsec_wrong')).status).toBe(401);
  });

  it('applies an event once, ignores it again, and keeps an older one from writing over a newer', async (ctx) => {
    if (!billing || !secret) return ctx.skip();
    // The actor's row names the customer, which is how the event finds it.
    await call('POST', '/api/admin/test/plan', { plan: 'trial', until: Date.now() + 86_400_000, customerId: customer });

    const created = await deliver(envelope(`evt_${customer}_1`, 'customer.subscription.created', '2026-10-10T00:00:05Z', subscription()));
    expect(await created.json()).toEqual({ applied: true });
    let plan = (await (await call('GET', '/api/me/plan')).json()) as { state: string; storageGb: number; source: string; until: number };
    expect(plan).toMatchObject({ state: 'active', source: 'stripe', storageGb: 35, until: Date.parse('2027-10-10T00:00:00Z') });

    const again = await deliver(envelope(`evt_${customer}_1`, 'customer.subscription.created', '2026-10-10T00:00:05Z', subscription()));
    expect(await again.json()).toEqual({ applied: false, reason: 'duplicate' });

    // A newer event, then an older one delivered late: the row stays with the newer.
    const later = subscription({ status: 'canceled', canceled_at: seconds('2026-10-12T00:00:00Z'), items: { data: [item(PLAN_PRICE, 1)], has_more: false } });
    expect(await (await deliver(envelope(`evt_${customer}_3`, 'customer.subscription.deleted', '2026-10-12T00:00:00Z', later))).json()).toEqual({ applied: true });
    expect(await (await deliver(envelope(`evt_${customer}_2`, 'customer.subscription.updated', '2026-10-11T00:00:00Z', subscription()))).json()).toEqual({ applied: false, reason: 'older' });
    plan = (await (await call('GET', '/api/me/plan')).json()) as typeof plan;
    expect(plan).toMatchObject({ state: 'active', storageGb: 10, until: Date.parse('2027-10-10T00:00:00Z') });
    expect(((await (await call('GET', '/api/me/plan')).json()) as { subscription: { status: string } }).subscription.status).toBe('canceled');

    // The first checkout's invoice, delivered before the subscription event that
    // happened a moment earlier: the row goes active from the invoice, and the
    // subscription event still applies with the storage only it carries.
    const customer2 = `${customer}b`;
    await call('POST', '/api/admin/test/plan', { plan: 'trial', until: Date.now() + 86_400_000, customerId: customer2 });
    const invoice = {
      id: 'in_first',
      status: 'paid',
      customer: customer2,
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_first' } },
      lines: { data: [{ id: 'il_1', amount: 6000, quantity: 1, pricing: { price_details: { price: PLAN_PRICE } }, period: { start: T0, end: NEXT_YEAR } }], has_more: false },
    };
    expect(await (await deliver(envelope(`evt_${customer2}_i`, 'invoice.paid', '2026-10-10T00:00:06Z', invoice))).json()).toEqual({ applied: true });
    expect(await (await deliver(envelope(`evt_${customer2}_s`, 'customer.subscription.created', '2026-10-10T00:00:05Z', subscription({ id: 'sub_first', customer: customer2 })))).json()).toEqual({ applied: true });
    plan = (await (await call('GET', '/api/me/plan')).json()) as typeof plan;
    expect(plan).toMatchObject({ state: 'active', source: 'stripe', storageGb: 35 });

    // An event for a customer no row holds is accepted and ignored.
    expect(await (await deliver(envelope(`evt_${customer}_9`, 'customer.subscription.created', '2026-10-12T00:00:00Z', subscription({ customer: 'cus_nobody' })))).json()).toEqual({ applied: false, reason: 'no account' });

    // A refund with nothing refunded on it is accepted and changes nothing. (A refund of
    // the plan reads the charge's invoice from Stripe and asks it to cancel the
    // subscription, which the sandbox refuses for ids it does not hold, so that case is
    // `src/routes/billing-webhook.test.ts`'s, against a stand-in Stripe.)
    const charge = { id: 'ch_first', amount: 6000, amount_refunded: 0, refunded: false, payment_intent: 'pi_first', customer: customer2 };
    expect(await (await deliver(envelope(`evt_${customer2}_r`, 'charge.refunded', '2026-10-13T00:00:00Z', charge))).json()).toEqual({ applied: false, reason: 'not followed' });
    plan = (await (await call('GET', '/api/me/plan')).json()) as typeof plan;
    expect(plan).toMatchObject({ state: 'active', storageGb: 35 });
  });
});
