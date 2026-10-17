/**
 * The read-only rule for a lapsed account (MAK-108), over HTTP against a live
 * `wrangler dev`: once an account's plan has ended, every write but a delete is a 402,
 * and every read still answers. The rule is global (`requireActivePlan`), so this
 * checks a sample of each kind rather than every route; `plan-middleware.test.ts`
 * holds the whole table.
 *
 * Only where the dev server sells a plan: billing is off without the `PADDLE_*`
 * settings in `.dev.vars`, and then there is nothing to check, which the cases report
 * as skipped. The sandbox's values, or five made-up ones of the right shape, both turn
 * it on; nothing here reaches Paddle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from '../src/lib/paddle.js';

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
    // half a gigabyte plus a tenth of the quota.
    const held = (await (await call('GET', '/api/me/plan?usage=1')).json()) as { usedBytes: number; storeBytes: number; storeLimitBytes: number };
    expect(held.usedBytes).toBe(0);
    expect(held.storeBytes).toBeGreaterThan(0);
    expect(held.storeLimitBytes).toBe(512 * 1024 ** 2 + 1024 ** 3);
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
 * Paddle's webhook, with a body signed the way Paddle signs one. Needs the dev server's
 * own secret, which the suite is given as `PADDLE_WEBHOOK_SECRET`; without it the cases
 * skip, since a signature with any other key is refused by design. The price ids the
 * server holds are given the same way (`PADDLE_PLAN_PRICE_ID`, `PADDLE_STORAGE_PRICE_ID`)
 * once `.dev.vars` carries the sandbox's rather than the stand-ins.
 */
describe('the webhook', () => {
  const secret = process.env['PADDLE_WEBHOOK_SECRET'];
  // The price ids the dev server holds, so an event's items are read as the plan and
  // the add-on; the stand-ins the worktree's `.dev.vars` starts with unless given.
  const PLAN_PRICE = process.env['PADDLE_PLAN_PRICE_ID'] ?? 'pri_local_plan';
  const STORAGE_PRICE = process.env['PADDLE_STORAGE_PRICE_ID'] ?? 'pri_local_storage';
  const customer = `ctm_test_${crypto.randomUUID().slice(0, 8)}`;

  async function deliver(event: Record<string, unknown>, key = secret ?? 'wrong'): Promise<Response> {
    const body = JSON.stringify(event);
    return fetch(`${BASE}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Paddle-Signature': await signWebhook(key, body, Math.floor(Date.now() / 1000)) },
      body,
    });
  }

  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_test',
    status: 'active',
    customer_id: customer,
    custom_data: null,
    current_billing_period: { starts_at: '2026-10-10T00:00:00Z', ends_at: '2027-10-10T00:00:00Z' },
    scheduled_change: null,
    items: [{ status: 'active', quantity: 1, price: { id: PLAN_PRICE } }, { status: 'active', quantity: 1, price: { id: STORAGE_PRICE } }],
    canceled_at: null,
    ...over,
  });

  it('refuses a body it cannot verify', async (ctx) => {
    if (!billing) return ctx.skip();
    expect((await deliver({ event_id: 'evt_x', event_type: 'subscription.created', occurred_at: '2026-10-10T00:00:00Z', data: subscription() }, 'pdl_ntfset_wrong')).status).toBe(401);
  });

  it('applies an event once, ignores it again, and keeps an older one from writing over a newer', async (ctx) => {
    if (!billing || !secret) return ctx.skip();
    // The actor's row names the customer, which is how the event finds it.
    await call('POST', '/api/admin/test/plan', { plan: 'trial', until: Date.now() + 86_400_000, paddleCustomerId: customer });

    const created = await deliver({ event_id: `evt_${customer}_1`, event_type: 'subscription.created', occurred_at: '2026-10-10T00:00:05Z', data: subscription() });
    expect(await created.json()).toEqual({ applied: true });
    let plan = (await (await call('GET', '/api/me/plan')).json()) as { state: string; storageGb: number; source: string; until: number };
    expect(plan).toMatchObject({ state: 'active', source: 'paddle', storageGb: 35, until: Date.parse('2027-10-10T00:00:00Z') });

    const again = await deliver({ event_id: `evt_${customer}_1`, event_type: 'subscription.created', occurred_at: '2026-10-10T00:00:05Z', data: subscription() });
    expect(await again.json()).toEqual({ applied: false, reason: 'duplicate' });

    // A newer event, then an older one delivered late: the row stays with the newer.
    const later = subscription({ status: 'canceled', current_billing_period: null, items: [{ status: 'active', quantity: 1, price: { id: PLAN_PRICE } }] });
    expect(await (await deliver({ event_id: `evt_${customer}_3`, event_type: 'subscription.canceled', occurred_at: '2026-10-12T00:00:00Z', data: later })).json()).toEqual({ applied: true });
    expect(await (await deliver({ event_id: `evt_${customer}_2`, event_type: 'subscription.updated', occurred_at: '2026-10-11T00:00:00Z', data: subscription() })).json()).toEqual({ applied: false, reason: 'older' });
    plan = (await (await call('GET', '/api/me/plan')).json()) as typeof plan;
    expect(plan).toMatchObject({ state: 'active', storageGb: 10, until: Date.parse('2027-10-10T00:00:00Z') });
    expect(((await (await call('GET', '/api/me/plan')).json()) as { subscription: { status: string } }).subscription.status).toBe('canceled');

    // The first checkout's transaction, delivered before the subscription event that
    // happened a moment earlier: the row goes active from the transaction, and the
    // subscription event still applies with the storage only it carries.
    const customer2 = `${customer}b`;
    await call('POST', '/api/admin/test/plan', { plan: 'trial', until: Date.now() + 86_400_000, paddleCustomerId: customer2 });
    const txn = { id: 'txn_first', status: 'completed', customer_id: customer2, subscription_id: 'sub_first', custom_data: null, billing_period: { starts_at: '2026-10-10T00:00:00Z', ends_at: '2027-10-10T00:00:00Z' }, items: [], checkout: null };
    expect(await (await deliver({ event_id: `evt_${customer2}_t`, event_type: 'transaction.completed', occurred_at: '2026-10-10T00:00:06Z', data: txn })).json()).toEqual({ applied: true });
    expect(await (await deliver({ event_id: `evt_${customer2}_s`, event_type: 'subscription.created', occurred_at: '2026-10-10T00:00:05Z', data: subscription({ id: 'sub_first', customer_id: customer2 }) })).json()).toEqual({ applied: true });
    plan = (await (await call('GET', '/api/me/plan')).json()) as typeof plan;
    expect(plan).toMatchObject({ state: 'active', source: 'paddle', storageGb: 35 });

    // An event for a customer no row holds is accepted and ignored.
    expect(await (await deliver({ event_id: `evt_${customer}_9`, event_type: 'subscription.created', occurred_at: '2026-10-12T00:00:00Z', data: subscription({ customer_id: 'ctm_nobody' }) })).json()).toEqual({ applied: false, reason: 'no account' });

    // A refund's adjustment is read: one of a one-off charge, or one still awaiting
    // Paddle's approval, is accepted and changes nothing. (A refund of the plan asks
    // Paddle to cancel the subscription, which the sandbox refuses for a subscription
    // it does not hold, so that case is the unit test's.)
    const adjustment = (over: Record<string, unknown> = {}) => ({
      id: 'adj_test',
      action: 'refund',
      type: 'full',
      status: 'approved',
      transaction_id: 'txn_first',
      subscription_id: 'sub_first',
      customer_id: customer2,
      items: [],
      ...over,
    });
    expect(await (await deliver({ event_id: `evt_${customer2}_a1`, event_type: 'adjustment.created', occurred_at: '2026-10-13T00:00:00Z', data: adjustment({ subscription_id: null }) })).json()).toEqual({ applied: false, reason: 'not followed' });
    expect(await (await deliver({ event_id: `evt_${customer2}_a2`, event_type: 'adjustment.created', occurred_at: '2026-10-13T00:00:00Z', data: adjustment({ status: 'pending_approval' }) })).json()).toEqual({ applied: false, reason: 'not followed' });
    plan = (await (await call('GET', '/api/me/plan')).json()) as typeof plan;
    expect(plan).toMatchObject({ state: 'active', storageGb: 35 });
  });
});
