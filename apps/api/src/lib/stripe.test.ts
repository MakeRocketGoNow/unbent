import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STRIPE_API_VERSION,
  STRIPE_IPS_RECHECK_MS,
  STRIPE_IPS_TTL_MS,
  StripeError,
  WEBHOOK_TOLERANCE_SECONDS,
  CHECKOUT_LIFETIME_S,
  billingOf,
  createCheckoutSession,
  createCustomer,
  expireOpenCheckouts,
  forgetStripeIps,
  formEncode,
  inCidrs,
  newestSubscription,
  periodEndOf,
  setSubscriptionStorage,
  signWebhook,
  stripeCall,
  stripeOf,
  verifyWebhookSignature,
  webhookSourceOf,
  type StripeConfig,
  type StripeSubscription,
} from './stripe.js';

const stripe: StripeConfig = {
  secretKey: 'sk_test_x',
  webhookSecret: 'whsec_secret',
  planPriceId: 'price_plan',
  storagePriceId: 'price_storage',
  environment: 'test',
  apiUrl: 'https://api.stripe.com',
};

const NOW = Date.UTC(2026, 9, 22, 12);

describe('stripeOf', () => {
  const all = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PLAN_PRICE_ID: 'price_plan',
    STRIPE_STORAGE_PRICE_ID: 'price_storage',
  };

  it('is all four settings or nothing, and reads the environment off the key', () => {
    expect(stripeOf({})).toBeUndefined();
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      expect(stripeOf({ ...all, [key]: ' ' }), key).toBeUndefined();
    }
    expect(stripeOf(all)?.environment).toBe('test');
    expect(stripeOf({ ...all, STRIPE_SECRET_KEY: 'rk_test_x' })?.environment).toBe('test');
    expect(stripeOf({ ...all, STRIPE_SECRET_KEY: 'sk_live_x' })?.environment).toBe('live');
    expect(stripeOf({ ...all, STRIPE_SECRET_KEY: 'rk_live_x' })?.environment).toBe('live');
    expect(stripeOf(all)?.apiUrl).toBe('https://api.stripe.com');
    expect(stripeOf({ ...all, STRIPE_API_URL: 'http://localhost:9999/' })?.apiUrl).toBe('http://localhost:9999');
  });

  it('tells the page only that there is a plan, and whether the money is real', () => {
    expect(billingOf({})).toBeUndefined();
    expect(billingOf(all)).toEqual({ environment: 'test' });
  });
});

describe('formEncode', () => {
  it('writes nested objects and arrays the way Stripe reads them, and leaves out what is unset', () => {
    const body = formEncode({
      mode: 'subscription',
      managed_payments: { enabled: true },
      line_items: [{ price: 'price_plan', quantity: 1 }, { price: 'price_storage', quantity: 2 }],
      metadata: { user_id: 'u 1' },
      nothing: null,
      missing: undefined,
    });
    expect(body.split('&')).toEqual([
      'mode=subscription',
      'managed_payments%5Benabled%5D=true',
      'line_items%5B0%5D%5Bprice%5D=price_plan',
      'line_items%5B0%5D%5Bquantity%5D=1',
      'line_items%5B1%5D%5Bprice%5D=price_storage',
      'line_items%5B1%5D%5Bquantity%5D=2',
      'metadata%5Buser_id%5D=u+1',
    ]);
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts what Stripe signs, and nothing changed from it', async () => {
    const body = '{"id":"evt_1","data":{"object":{"id":"sub_1"}}}';
    const header = await signWebhook('whsec_secret', body, NOW / 1000);
    expect(await verifyWebhookSignature('whsec_secret', header, body, NOW)).toBe(true);
    expect(await verifyWebhookSignature('whsec_secret', header, body + ' ', NOW)).toBe(false);
    expect(await verifyWebhookSignature('whsec_other', header, body, NOW)).toBe(false);
    expect(await verifyWebhookSignature('whsec_secret', undefined, body, NOW)).toBe(false);
    expect(await verifyWebhookSignature('whsec_secret', 't=,v1=', body, NOW)).toBe(false);
    expect(await verifyWebhookSignature('whsec_secret', 'v1=zz', body, NOW)).toBe(false);
    // A `v0` is not a scheme this reads.
    expect(await verifyWebhookSignature('whsec_secret', `t=${NOW / 1000},v0=${'ab'.repeat(32)}`, body, NOW)).toBe(false);
  });

  it('refuses a delivery older than the tolerance, as a replay', async () => {
    const body = '{}';
    const ts = NOW / 1000 - WEBHOOK_TOLERANCE_SECONDS - 1;
    const header = await signWebhook('whsec_secret', body, ts);
    expect(await verifyWebhookSignature('whsec_secret', header, body, NOW)).toBe(false);
    const fresh = await signWebhook('whsec_secret', body, NOW / 1000 - WEBHOOK_TOLERANCE_SECONDS + 1);
    expect(await verifyWebhookSignature('whsec_secret', fresh, body, NOW)).toBe(true);
  });

  it('takes any of several signatures while a secret is being rolled', async () => {
    const body = '{}';
    const ts = NOW / 1000;
    const old = (await signWebhook('whsec_old', body, ts)).split(',')[1];
    const current = (await signWebhook('whsec_secret', body, ts)).split(',')[1];
    expect(await verifyWebhookSignature('whsec_secret', `t=${ts},${old},${current}`, body, NOW)).toBe(true);
  });
});

describe('the Stripe calls', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  function answer(responses: Array<[number, unknown]>) {
    calls.length = 0;
    let i = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const [status, body] = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(JSON.stringify(body), { status });
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  it('pins the version, sends forms, and keeps a refusal\'s code', async () => {
    answer([[200, { id: 'x' }]]);
    expect(await stripeCall(stripe, 'GET', '/v1/x')).toEqual({ id: 'x' });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/x');
    expect(new Headers(calls[0]!.init.headers).get('Stripe-Version')).toBe(STRIPE_API_VERSION);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer sk_test_x');
    expect(calls[0]!.init.body).toBeUndefined();

    answer([[200, { id: 'cus_1' }]]);
    await stripeCall(stripe, 'POST', '/v1/customers', { email: 'jo@example.com', metadata: { user_id: 'u1' } });
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.init.body).toBe('email=jo%40example.com&metadata%5Buser_id%5D=u1');

    answer([[402, { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } }]]);
    await expect(stripeCall(stripe, 'POST', '/v1/subscriptions/sub_1', {})).rejects.toMatchObject({ status: 402, code: 'card_declined' });
    expect(() => {
      throw new StripeError(500, null, 'x');
    }).toThrow('Stripe answered 500: x');

    // No answer at all is out of reach, as a refusal is, not a bare error.
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    await expect(stripeCall(stripe, 'GET', '/v1/x')).rejects.toMatchObject({ name: 'StripeError', status: 0, code: 'unreachable' });
  });

  it('opens a checkout with Managed Payments on, the plan and the add-ons, and the account named twice', async () => {
    answer([[200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }]]);
    const session = await createCheckoutSession(stripe, {
      customerId: 'cus_1',
      userId: 'u1',
      storage: 2,
      successUrl: 'https://unbent.test/settings/plan?checkout=complete',
      cancelUrl: 'https://unbent.test/settings/plan',
    });
    expect(session.url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const sent = new URLSearchParams(calls[0]!.init.body as string);
    expect(sent.get('mode')).toBe('subscription');
    expect(sent.get('managed_payments[enabled]')).toBe('true');
    expect(sent.get('customer')).toBe('cus_1');
    expect(sent.get('client_reference_id')).toBe('u1');
    expect(sent.get('subscription_data[metadata][user_id]')).toBe('u1');
    expect(sent.get('line_items[0][price]')).toBe('price_plan');
    expect(sent.get('line_items[0][quantity]')).toBe('1');
    expect(sent.get('line_items[1][price]')).toBe('price_storage');
    expect(sent.get('line_items[1][quantity]')).toBe('2');
    // Nothing the seller of record decides is passed.
    for (const key of ['automatic_tax[enabled]', 'tax_id_collection[enabled]', 'payment_method_types[0]', 'customer_update[address]']) {
      expect(sent.has(key), key).toBe(false);
    }
    // Payable for an hour, not Stripe's default day.
    const expires = Number(sent.get('expires_at'));
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(CHECKOUT_LIFETIME_S - 5);
    expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(CHECKOUT_LIFETIME_S);
    answer([[200, { id: 'cs_2', url: 'x' }]]);
    await createCheckoutSession(stripe, { customerId: 'cus_1', userId: 'u1', storage: 0, successUrl: 'a', cancelUrl: 'b' });
    expect(new URLSearchParams(calls[0]!.init.body as string).has('line_items[1][price]')).toBe(false);
  });

  it('makes one customer per account however many presses ask for it', async () => {
    answer([[200, { id: 'cus_1' }]]);
    await createCustomer(stripe, 'jo@example.com', 'u1');
    expect(new Headers(calls[0]!.init.headers).get('Idempotency-Key')).toBe('customer-u1');
  });

  it("expires the customer's open checkouts, and takes one already closed as done", async () => {
    answer([
      [200, { data: [{ id: 'cs_1' }, { id: 'cs_2' }], has_more: false }],
      [200, { id: 'cs_1', status: 'expired' }],
      [400, { error: { type: 'invalid_request_error', message: 'Only open sessions can be expired.' } }],
    ]);
    await expireOpenCheckouts(stripe, 'cus_1');
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://api.stripe.com/v1/checkout/sessions?customer=cus_1&status=open&limit=100',
      'POST https://api.stripe.com/v1/checkout/sessions/cs_1/expire',
      'POST https://api.stripe.com/v1/checkout/sessions/cs_2/expire',
    ]);
    answer([
      [200, { data: [{ id: 'cs_1' }], has_more: false }],
      [500, { error: { type: 'api_error', message: 'Something went wrong.' } }],
    ]);
    await expect(expireOpenCheckouts(stripe, 'cus_1')).rejects.toMatchObject({ status: 500 });
  });

  it('finds a customer\'s newest subscription whatever its status, and none for a customer without one', async () => {
    answer([[200, { data: [
      { id: 'sub_old', status: 'canceled', created: 1_700_000_000 },
      { id: 'sub_new', status: 'active', created: 1_792_000_000 },
    ], has_more: false }]]);
    expect((await newestSubscription(stripe, 'cus_1'))?.id).toBe('sub_new');
    expect(calls[0]!.url).toContain('/v1/subscriptions?customer=cus_1&status=all');
    answer([[200, { data: [], has_more: false }]]);
    expect(await newestSubscription(stripe, 'cus_1')).toBeNull();
  });

  const sub = (items: StripeSubscription['items']['data']): StripeSubscription => ({
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    created: 1_792_000_000,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: {},
    items: { data: items, has_more: false },
  });
  const planItem = { id: 'si_plan', price: { id: 'price_plan' }, quantity: 1, current_period_start: 1_792_000_000, current_period_end: 1_823_536_000 };
  const storageItem = { id: 'si_storage', price: { id: 'price_storage' }, quantity: 1, current_period_start: 1_792_000_000, current_period_end: 1_823_536_000 };

  it('reads the paid period off the items, where this API version keeps it', () => {
    expect(periodEndOf(sub([planItem, storageItem]))).toBe(1_823_536_000);
    expect(periodEndOf(sub([]))).toBeNull();
  });

  it('changes the add-on by its item, charging now or not, and leaves the plan item alone', async () => {
    answer([[200, { id: 'sub_1' }]]);
    await setSubscriptionStorage(stripe, sub([planItem, storageItem]), 3, 'charge-now');
    let sent = new URLSearchParams(calls[0]!.init.body as string);
    expect(sent.get('items[0][id]')).toBe('si_storage');
    expect(sent.get('items[0][quantity]')).toBe('3');
    expect(sent.has('items[1][id]')).toBe(false);
    expect(sent.get('proration_behavior')).toBe('always_invoice');
    expect(sent.get('payment_behavior')).toBe('error_if_incomplete');

    // A first block is a new item; taking the last one off deletes it, with nothing credited.
    answer([[200, { id: 'sub_1' }]]);
    await setSubscriptionStorage(stripe, sub([planItem]), 1, 'charge-now');
    sent = new URLSearchParams(calls[0]!.init.body as string);
    expect(sent.get('items[0][price]')).toBe('price_storage');
    expect(sent.get('items[0][quantity]')).toBe('1');

    answer([[200, { id: 'sub_1' }]]);
    await setSubscriptionStorage(stripe, sub([planItem, storageItem]), 0, 'no-charge');
    sent = new URLSearchParams(calls[0]!.init.body as string);
    expect(sent.get('items[0][id]')).toBe('si_storage');
    expect(sent.get('items[0][deleted]')).toBe('true');
    expect(sent.get('proration_behavior')).toBe('none');
    expect(sent.has('payment_behavior')).toBe(false);

    // Nothing to change is no call.
    answer([[500, {}]]);
    await setSubscriptionStorage(stripe, sub([planItem]), 0, 'no-charge');
    expect(calls).toHaveLength(0);
  });
});

describe('where a webhook may come from', () => {
  const LIST = ['3.18.12.63', '54.187.174.169'];
  const urls: string[] = [];
  function publish(...lists: Array<string[] | number>) {
    urls.length = 0;
    let i = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const next = lists[Math.min(i++, lists.length - 1)]!;
      return typeof next === 'number' ? new Response('down', { status: next }) : Response.json({ WEBHOOKS: next });
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetStripeIps();
  });

  it('matches an address against the list, bare addresses and ranges alike', () => {
    expect(inCidrs('3.18.12.63', LIST)).toBe(true);
    expect(inCidrs('3.18.12.64', LIST)).toBe(false);
    expect(inCidrs('203.0.113.77', ['203.0.113.0/24'])).toBe(true);
    expect(inCidrs('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
    // The top half of the address space, where a 32-bit shift would go negative.
    expect(inCidrs('200.1.2.3', ['200.0.0.0/8'])).toBe(true);
    expect(inCidrs('2600::1', LIST)).toBe(false);
    expect(inCidrs('3.18.12', LIST)).toBe(false);
  });

  it("asks Stripe's published list once and keeps the answer", async () => {
    publish(LIST);
    expect(await webhookSourceOf('3.18.12.63', false, NOW)).toBe('allowed');
    expect(await webhookSourceOf('54.187.174.169', false, NOW + 1000)).toBe('allowed');
    expect(urls).toEqual(['https://stripe.com/files/ips/ips_webhooks.json']);
  });

  it('refuses any other address, asking again for the list at most every few minutes', async () => {
    publish(LIST);
    expect(await webhookSourceOf('198.51.100.7', false, NOW)).toBe('refused');
    expect(urls).toHaveLength(1);
    expect(await webhookSourceOf('198.51.100.7', false, NOW + STRIPE_IPS_RECHECK_MS - 1)).toBe('refused');
    expect(urls).toHaveLength(1);
    expect(await webhookSourceOf(undefined, false, NOW)).toBe('refused');
  });

  it('lets in an address Stripe added since the list was read, once the recheck is due', async () => {
    publish(LIST, [...LIST, '35.157.207.129']);
    expect(await webhookSourceOf('3.18.12.63', false, NOW)).toBe('allowed');
    expect(await webhookSourceOf('35.157.207.129', false, NOW + STRIPE_IPS_RECHECK_MS)).toBe('allowed');
    expect(urls).toHaveLength(2);
  });

  it('keeps an old list when Stripe cannot be read, and says unknown with none', async () => {
    publish(503);
    expect(await webhookSourceOf('3.18.12.63', false, NOW)).toBe('unknown');
    forgetStripeIps();

    publish(LIST, 503);
    expect(await webhookSourceOf('3.18.12.63', false, NOW)).toBe('allowed');
    expect(await webhookSourceOf('3.18.12.63', false, NOW + STRIPE_IPS_TTL_MS)).toBe('allowed');
    expect(urls).toHaveLength(2);
  });

  it('waits before asking again after a failure, rather than on every request', async () => {
    publish(503);
    expect(await webhookSourceOf('3.18.12.63', false, NOW)).toBe('unknown');
    expect(await webhookSourceOf('3.18.12.63', false, NOW + 1000)).toBe('unknown');
    expect(urls).toHaveLength(1);
    forgetStripeIps();

    publish(LIST, 503, LIST);
    expect(await webhookSourceOf('3.18.12.63', false, NOW)).toBe('allowed');
    const stale = NOW + STRIPE_IPS_TTL_MS;
    expect(await webhookSourceOf('3.18.12.63', false, stale)).toBe('allowed');
    // Neither a delivery nor a stranger's knock asks again inside the wait.
    expect(await webhookSourceOf('3.18.12.63', false, stale + 1000)).toBe('allowed');
    expect(await webhookSourceOf('198.51.100.7', false, stale + 1000)).toBe('refused');
    expect(urls).toHaveLength(2);
    expect(await webhookSourceOf('3.18.12.63', false, stale + STRIPE_IPS_RECHECK_MS)).toBe('allowed');
    expect(urls).toHaveLength(3);
  });

  it('lets loopback through only where the test switch is on', async () => {
    publish(LIST);
    expect(await webhookSourceOf('127.0.0.1', true, NOW)).toBe('allowed');
    expect(await webhookSourceOf(undefined, true, NOW)).toBe('allowed');
    expect(urls).toHaveLength(0);
    expect(await webhookSourceOf('127.0.0.1', false, NOW)).toBe('refused');
  });
});
