import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PADDLE_IPS_RECHECK_MS,
  PADDLE_IPS_TTL_MS,
  PaddleError,
  WEBHOOK_TOLERANCE_SECONDS,
  findOrCreateCustomer,
  forgetPaddleIps,
  inCidrs,
  newestSubscription,
  paddleCall,
  setSubscriptionStorage,
  signWebhook,
  verifyWebhookSignature,
  webhookSourceOf,
  type PaddleConfig,
} from './paddle.js';

const paddle: PaddleConfig = {
  apiKey: 'pdl_sdbx_apikey_x',
  webhookSecret: 'pdl_ntfset_secret',
  clientToken: 'test_x',
  planPriceId: 'pri_plan',
  storagePriceId: 'pri_storage',
  environment: 'sandbox',
  apiUrl: 'https://sandbox-api.paddle.com',
};

const NOW = Date.UTC(2026, 9, 10, 12);

describe('verifyWebhookSignature', () => {
  it('accepts what Paddle signs, and nothing changed from it', async () => {
    const body = '{"event_id":"evt_1","data":{"id":"sub_1"}}';
    const header = await signWebhook('pdl_ntfset_secret', body, NOW / 1000);
    expect(await verifyWebhookSignature('pdl_ntfset_secret', header, body, NOW)).toBe(true);
    expect(await verifyWebhookSignature('pdl_ntfset_secret', header, body + ' ', NOW)).toBe(false);
    expect(await verifyWebhookSignature('pdl_ntfset_other', header, body, NOW)).toBe(false);
    expect(await verifyWebhookSignature('pdl_ntfset_secret', undefined, body, NOW)).toBe(false);
    expect(await verifyWebhookSignature('pdl_ntfset_secret', 'ts=;h1=', body, NOW)).toBe(false);
    expect(await verifyWebhookSignature('pdl_ntfset_secret', 'h1=zz', body, NOW)).toBe(false);
  });

  it('refuses a delivery older than the tolerance, as a replay', async () => {
    const body = '{}';
    const ts = NOW / 1000 - WEBHOOK_TOLERANCE_SECONDS - 1;
    const header = await signWebhook('pdl_ntfset_secret', body, ts);
    expect(await verifyWebhookSignature('pdl_ntfset_secret', header, body, NOW)).toBe(false);
    const fresh = await signWebhook('pdl_ntfset_secret', body, NOW / 1000 - WEBHOOK_TOLERANCE_SECONDS + 1);
    expect(await verifyWebhookSignature('pdl_ntfset_secret', fresh, body, NOW)).toBe(true);
  });

  it('takes any of several signatures while a secret is being rotated', async () => {
    const body = '{}';
    const ts = NOW / 1000;
    const old = (await signWebhook('pdl_ntfset_old', body, ts)).split(';')[1];
    const current = (await signWebhook('pdl_ntfset_secret', body, ts)).split(';')[1];
    expect(await verifyWebhookSignature('pdl_ntfset_secret', `ts=${ts};${old};${current}`, body, NOW)).toBe(true);
  });
});

describe('the Paddle calls', () => {
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

  it('unwraps data, pins the version, and keeps a refusal\'s code', async () => {
    answer([[200, { data: { id: 'x' } }]]);
    expect(await paddleCall(paddle, 'GET', '/x')).toEqual({ id: 'x' });
    expect(calls[0]!.url).toBe('https://sandbox-api.paddle.com/x');
    expect(new Headers(calls[0]!.init.headers).get('Paddle-Version')).toBe('1');
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer pdl_sdbx_apikey_x');

    answer([[409, { error: { code: 'customer_already_exists', detail: 'customer email conflicts' } }]]);
    await expect(paddleCall(paddle, 'POST', '/customers', {})).rejects.toMatchObject({ status: 409, code: 'customer_already_exists' });
    expect(() => {
      throw new PaddleError(500, null, 'x');
    }).toThrow('Paddle answered 500: x');
  });

  it('finds the customer Paddle already has for an address rather than failing the checkout', async () => {
    answer([
      [409, { error: { code: 'customer_already_exists', detail: '' } }],
      [200, { data: [{ id: 'ctm_other', email: 'other@example.com' }, { id: 'ctm_1', email: 'Jo@Example.com' }] }],
    ]);
    expect(await findOrCreateCustomer(paddle, 'jo@example.com', 'u1')).toEqual({ id: 'ctm_1', email: 'Jo@Example.com' });
    expect(calls[1]!.url).toContain('/customers?email=jo%40example.com');
  });

  it('finds a customer\'s newest subscription whatever its status, and none for a customer without one', async () => {
    answer([[200, { data: [
      { id: 'sub_old', status: 'canceled', created_at: '2025-10-01T00:00:00Z' },
      { id: 'sub_new', status: 'active', created_at: '2026-10-14T20:28:03Z' },
    ] }]]);
    expect((await newestSubscription(paddle, 'ctm_1'))?.id).toBe('sub_new');
    expect(calls[0]!.url).toContain('/subscriptions?customer_id=ctm_1&status=');
    answer([[200, { data: [] }]]);
    expect(await newestSubscription(paddle, 'ctm_1')).toBeNull();
  });

  it('sends the whole item list when changing storage, with the plan kept', async () => {
    answer([[200, { data: { id: 'sub_1' } }]]);
    await setSubscriptionStorage(paddle, 'sub_1', 2);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      items: [
        { price_id: 'pri_plan', quantity: 1 },
        { price_id: 'pri_storage', quantity: 2 },
      ],
      proration_billing_mode: 'prorated_immediately',
    });
    answer([[200, { data: { id: 'sub_1' } }]]);
    await setSubscriptionStorage(paddle, 'sub_1', 0);
    expect(JSON.parse(calls[0]!.init.body as string).items).toEqual([{ price_id: 'pri_plan', quantity: 1 }]);
  });
});

describe('where a webhook may come from', () => {
  const LIVE = ['34.237.3.244/32', '52.11.166.252/32'];
  const urls: string[] = [];
  function publish(...lists: Array<string[] | number>) {
    urls.length = 0;
    let i = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const next = lists[Math.min(i++, lists.length - 1)]!;
      return typeof next === 'number'
        ? new Response('down', { status: next })
        : Response.json({ data: { ipv4_cidrs: next } });
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetPaddleIps();
  });

  it('matches an address against CIDRs, including ranges wider than one address', () => {
    expect(inCidrs('34.237.3.244', LIVE)).toBe(true);
    expect(inCidrs('34.237.3.245', LIVE)).toBe(false);
    expect(inCidrs('203.0.113.77', ['203.0.113.0/24'])).toBe(true);
    expect(inCidrs('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
    // The top half of the address space, where a 32-bit shift would go negative.
    expect(inCidrs('200.1.2.3', ['200.0.0.0/8'])).toBe(true);
    expect(inCidrs('2600::1', LIVE)).toBe(false);
    expect(inCidrs('34.237.3', LIVE)).toBe(false);
  });

  it("asks the environment's own origin, never the stand-in, and keeps the answer", async () => {
    publish(LIVE);
    const live = { ...paddle, environment: 'live' as const, apiUrl: 'http://localhost:9999' };
    expect(await webhookSourceOf(live, '34.237.3.244', false, NOW)).toBe('allowed');
    expect(await webhookSourceOf(live, '52.11.166.252', false, NOW + 1000)).toBe('allowed');
    expect(urls).toEqual(['https://api.paddle.com/ips']);

    forgetPaddleIps();
    publish(['44.241.183.62/32']);
    expect(await webhookSourceOf(paddle, '44.241.183.62', false, NOW)).toBe('allowed');
    expect(urls).toEqual(['https://sandbox-api.paddle.com/ips']);
  });

  it('refuses any other address, asking again for the list at most every few minutes', async () => {
    publish(LIVE);
    expect(await webhookSourceOf(paddle, '198.51.100.7', false, NOW)).toBe('refused');
    expect(urls).toHaveLength(1);
    expect(await webhookSourceOf(paddle, '198.51.100.7', false, NOW + PADDLE_IPS_RECHECK_MS - 1)).toBe('refused');
    expect(urls).toHaveLength(1);
    expect(await webhookSourceOf(paddle, undefined, false, NOW)).toBe('refused');
  });

  it('lets in an address Paddle added since the list was read, once the recheck is due', async () => {
    publish(LIVE, [...LIVE, '35.155.119.135/32']);
    expect(await webhookSourceOf(paddle, '34.237.3.244', false, NOW)).toBe('allowed');
    expect(await webhookSourceOf(paddle, '35.155.119.135', false, NOW + PADDLE_IPS_RECHECK_MS)).toBe('allowed');
    expect(urls).toHaveLength(2);
  });

  it('keeps an old list when Paddle cannot be read, and says unknown with none', async () => {
    publish(503);
    expect(await webhookSourceOf(paddle, '34.237.3.244', false, NOW)).toBe('unknown');

    publish(LIVE, 503);
    expect(await webhookSourceOf(paddle, '34.237.3.244', false, NOW)).toBe('allowed');
    expect(await webhookSourceOf(paddle, '34.237.3.244', false, NOW + PADDLE_IPS_TTL_MS)).toBe('allowed');
    expect(urls).toHaveLength(2);
  });

  it('lets loopback through only where the test switch is on', async () => {
    publish(LIVE);
    expect(await webhookSourceOf(paddle, '127.0.0.1', true, NOW)).toBe('allowed');
    expect(await webhookSourceOf(paddle, undefined, true, NOW)).toBe('allowed');
    expect(urls).toHaveLength(0);
    expect(await webhookSourceOf(paddle, '127.0.0.1', false, NOW)).toBe('refused');
  });
});
