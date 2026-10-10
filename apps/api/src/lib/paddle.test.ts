import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PaddleError,
  WEBHOOK_TOLERANCE_SECONDS,
  findOrCreateCustomer,
  paddleCall,
  setSubscriptionStorage,
  signWebhook,
  verifyWebhookSignature,
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
