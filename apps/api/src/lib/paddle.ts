import type { BillingConfig } from '@unbent/shared';

/**
 * Paddle, the merchant of record for unbent.app's plan (MAK-108, decided in MAK-47): the
 * configuration that turns billing on, and the handful of calls the Worker makes to it.
 *
 * Paddle rather than Stripe because at $36 a year sold anywhere, being the seller means
 * registering for VAT from the first European sale; a merchant of record is the seller,
 * and takes that with it. No SDK: Paddle's is a Node package wrapping a dozen `fetch`
 * calls, and the Worker needs six of them.
 *
 * Billing is one thing, on or off: every setting below, or none of them. An instance that
 * sets none — every fresh checkout, every fork — has no plan to sell, so nothing here
 * runs, every account reads as `active` with no end, and no Plan page is drawn. A
 * half-set configuration is treated as none, the way a half-set OAuth pair is, rather
 * than as a checkout that fails when pressed.
 */
export interface PaddleEnv {
  /**
   * The API key, `pdl_sdbx_apikey_…` for the sandbox and `pdl_live_apikey_…` for the live
   * account. Which environment this instance talks to is read off it, so the two cannot
   * be mixed: a sandbox key with live price ids is refused by Paddle, not by anything
   * here, but at least the key says where the request goes. Made under Paddle > Developer
   * tools > Authentication with the permissions `customer`, `transaction`, `subscription`
   * (read and write) and `customer_portal_session` (write).
   */
  PADDLE_API_KEY?: string;
  /**
   * The notification destination's secret, `pdl_ntfset_…`, which every webhook is signed
   * with. Per destination: the sandbox's and the live account's differ, as everything of
   * theirs does.
   */
  PADDLE_WEBHOOK_SECRET?: string;
  /**
   * The client-side token Paddle.js initialises with on the Plan page, `test_…` for the
   * sandbox and `live_…` for live. Public by design — it ships in the page — and in
   * `/api/config` for that reason; it can open a checkout and nothing else.
   */
  PADDLE_CLIENT_TOKEN?: string;
  /** The plan's price, `pri_…`, as made in Paddle > Catalog: $36 a year. */
  PADDLE_PLAN_PRICE_ID?: string;
  /** The storage add-on's price, `pri_…`: $12 a year, sold by quantity. */
  PADDLE_STORAGE_PRICE_ID?: string;
  /**
   * Where the API calls go instead of Paddle, for a stand-in during development and the
   * live suite's checkout test. A deployed instance leaves it unset.
   */
  PADDLE_API_URL?: string;
}

export interface PaddleConfig {
  apiKey: string;
  webhookSecret: string;
  clientToken: string;
  planPriceId: string;
  storagePriceId: string;
  environment: 'sandbox' | 'live';
  /** The API's origin, no trailing slash. */
  apiUrl: string;
}

const SANDBOX_API = 'https://sandbox-api.paddle.com';
const LIVE_API = 'https://api.paddle.com';

/** Everything billing needs, or undefined when any of it is missing. */
export function paddleOf(env: PaddleEnv): PaddleConfig | undefined {
  const apiKey = env.PADDLE_API_KEY?.trim();
  const webhookSecret = env.PADDLE_WEBHOOK_SECRET?.trim();
  const clientToken = env.PADDLE_CLIENT_TOKEN?.trim();
  const planPriceId = env.PADDLE_PLAN_PRICE_ID?.trim();
  const storagePriceId = env.PADDLE_STORAGE_PRICE_ID?.trim();
  if (!apiKey || !webhookSecret || !clientToken || !planPriceId || !storagePriceId) return undefined;
  const environment = apiKey.startsWith('pdl_sdbx_') ? 'sandbox' : 'live';
  const apiUrl = (env.PADDLE_API_URL?.trim() || (environment === 'sandbox' ? SANDBOX_API : LIVE_API)).replace(/\/$/, '');
  return { apiKey, webhookSecret, clientToken, planPriceId, storagePriceId, environment, apiUrl };
}

/** Whether this instance sells a plan at all. */
export function billingOn(env: PaddleEnv): boolean {
  return paddleOf(env) !== undefined;
}

/** What `/api/config` says about billing: the page's half of the configuration, or nothing. */
export function billingOf(env: PaddleEnv): BillingConfig | undefined {
  const paddle = paddleOf(env);
  return paddle ? { environment: paddle.environment, clientToken: paddle.clientToken } : undefined;
}

// --- The API ---------------------------------------------------------------------------

/** A refusal from Paddle: the status, and its own words from the body, cut short for the log. */
export class PaddleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    detail: string,
  ) {
    super(`Paddle answered ${status}${code ? ` ${code}` : ''}: ${detail}`);
    this.name = 'PaddleError';
  }
}

/** How long one call may take. Paddle answers in well under a second; a hang must not hold a deletion or a checkout open. */
export const PADDLE_TIMEOUT_MS = 10_000;

/**
 * One call. Every Paddle answer wraps its entity in `data`, and a refusal carries
 * `error.code` and `error.detail`, which the thrown error keeps for the few callers that
 * branch on a code (a customer that already exists). The version header pins the API's
 * shape against the one this was written to, rather than to whatever the account's
 * default becomes. A call that does not answer in `PADDLE_TIMEOUT_MS` throws as the
 * fetch does, which every caller answers as Paddle being out of reach.
 */
export async function paddleCall<T>(
  paddle: PaddleConfig,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${paddle.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${paddle.apiKey}`,
      'Paddle-Version': '1',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(PADDLE_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: { data?: T; error?: { code?: string; detail?: string } } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // Not JSON: a gateway page. The status and the first line of it say enough.
  }
  if (!res.ok) throw new PaddleError(res.status, json.error?.code ?? null, (json.error?.detail ?? text).slice(0, 200));
  if (json.data === undefined) throw new PaddleError(res.status, null, 'no data in the answer');
  return json.data;
}

export interface PaddleCustomer {
  id: string;
  email: string;
}

/**
 * The Paddle customer for an account, found or made. Paddle keeps customers unique by
 * email and refuses a second with the same one (`customer_already_exists`), so a
 * customer made for this address some other way — by hand in the dashboard, by a
 * checkout before this code stored the id — is found by listing the email rather than
 * failing the checkout. `custom_data.user_id` is this account's id, so Paddle's side
 * names ours; the join the webhook uses is the customer id on the plan row.
 */
export async function findOrCreateCustomer(paddle: PaddleConfig, email: string, userId: string): Promise<PaddleCustomer> {
  try {
    return await paddleCall<PaddleCustomer>(paddle, 'POST', '/customers', { email, custom_data: { user_id: userId } });
  } catch (err) {
    if (!(err instanceof PaddleError && err.code === 'customer_already_exists')) throw err;
    const found = await paddleCall<PaddleCustomer[]>(paddle, 'GET', `/customers?email=${encodeURIComponent(email)}&status=active,archived`);
    const customer = found.find((c) => c.email.toLowerCase() === email.toLowerCase());
    if (!customer) throw err;
    return customer;
  }
}

export interface PaddleTransaction {
  id: string;
  status: string;
  customer_id: string | null;
  subscription_id: string | null;
  custom_data: Record<string, unknown> | null;
  billing_period: { starts_at: string; ends_at: string } | null;
  items: Array<{ price: { id: string }; quantity: number }>;
  checkout: { url: string | null } | null;
}

/**
 * A transaction for the checkout to open: the plan, and `storage` add-ons with it. Made
 * here rather than by Paddle.js from a price list so that the customer is ours before
 * the checkout opens — the plan row holds the id by then — and so that the page never
 * learns a price id. Paddle copies `custom_data` from the transaction to the
 * subscription it makes, which is how a subscription event names the account too.
 */
export async function createCheckoutTransaction(
  paddle: PaddleConfig,
  customerId: string,
  userId: string,
  storage: number,
): Promise<PaddleTransaction> {
  const items = [{ price_id: paddle.planPriceId, quantity: 1 }];
  if (storage > 0) items.push({ price_id: paddle.storagePriceId, quantity: storage });
  return paddleCall<PaddleTransaction>(paddle, 'POST', '/transactions', {
    items,
    customer_id: customerId,
    custom_data: { user_id: userId },
  });
}

export interface PaddleSubscription {
  id: string;
  status: string;
  /** When Paddle last changed it, RFC 3339: what a read of it is stamped with on the row. */
  updated_at?: string;
  created_at?: string;
  customer_id: string;
  custom_data: Record<string, unknown> | null;
  current_billing_period: { starts_at: string; ends_at: string } | null;
  scheduled_change: { action: string; effective_at: string } | null;
  items: Array<{ status: string; quantity: number; price: { id: string } }>;
  canceled_at: string | null;
}

export async function getSubscription(paddle: PaddleConfig, subscriptionId: string): Promise<PaddleSubscription> {
  return paddleCall<PaddleSubscription>(paddle, 'GET', `/subscriptions/${subscriptionId}`);
}

/**
 * The customer's newest subscription, or null for a customer who has none. For a row
 * that has a customer but no subscription yet: the first checkout's subscription reaches
 * the row by webhook, and a page re-reading its plan the moment the overlay closes
 * would otherwise find nothing to read until it lands — or never, for a webhook lost for
 * longer than Paddle retries. Newest by creation, whatever its status, so a lapsed one
 * is reported as lapsed rather than hidden.
 */
export async function newestSubscription(paddle: PaddleConfig, customerId: string): Promise<PaddleSubscription | null> {
  const subs = await paddleCall<PaddleSubscription[]>(
    paddle,
    'GET',
    `/subscriptions?customer_id=${encodeURIComponent(customerId)}&status=active,trialing,past_due,paused,canceled&per_page=50`,
  );
  if (subs.length === 0) return null;
  return subs.reduce((newest, s) => ((s.created_at ?? '') > (newest.created_at ?? '') ? s : newest));
}

/**
 * The subscription's storage set to `storage` add-ons, charged for the rest of the
 * period now. The items are the whole list — Paddle reads an item left out as removed —
 * so the plan goes with them, and the quantity is the new total rather than a delta: two
 * presses of "25 GB more" land as two quantities, not as one applied twice. Prorated and
 * collected at once, so the quota is the webhook's to raise the moment the payment is
 * through, and a card that fails leaves the subscription as it was (`prevent_change`,
 * Paddle's default).
 */
export async function setSubscriptionStorage(paddle: PaddleConfig, subscriptionId: string, storage: number): Promise<PaddleSubscription> {
  const items = [{ price_id: paddle.planPriceId, quantity: 1 }];
  if (storage > 0) items.push({ price_id: paddle.storagePriceId, quantity: storage });
  return paddleCall<PaddleSubscription>(paddle, 'PATCH', `/subscriptions/${subscriptionId}`, {
    items,
    proration_billing_mode: 'prorated_immediately',
  });
}

/**
 * Ends a subscription at once. For account deletion: the account is going, and a
 * subscription left behind would charge a card for a store that no longer exists. No
 * refund is made for the period's remainder; Paddle keeps its fee on refunds, and the
 * terms say deletion ends the plan.
 */
export async function cancelSubscriptionNow(paddle: PaddleConfig, subscriptionId: string): Promise<void> {
  await paddleCall(paddle, 'POST', `/subscriptions/${subscriptionId}/cancel`, { effective_from: 'immediately' });
}

export interface PaddlePortalSession {
  urls: {
    general: { overview: string };
    subscriptions: Array<{
      id: string;
      cancel_subscription: string;
      update_subscription_payment_method: string;
    }>;
  };
}

/**
 * A fresh portal link. Each is a short-lived token, so one is made per press and never
 * kept; with the subscription named, the answer carries the cancel and the
 * update-payment forms as links of their own.
 */
export async function createPortalSession(paddle: PaddleConfig, customerId: string, subscriptionId: string | null): Promise<PaddlePortalSession> {
  return paddleCall<PaddlePortalSession>(
    paddle,
    'POST',
    `/customers/${customerId}/portal-sessions`,
    subscriptionId ? { subscription_ids: [subscriptionId] } : {},
  );
}

// --- Webhooks ---------------------------------------------------------------------------

/** How far a webhook's timestamp may be from the clock before it is refused as a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Whether a webhook came from Paddle: `Paddle-Signature` is `ts=<unix seconds>;h1=<hex>`,
 * and `h1` is HMAC-SHA256 over `<ts>:<raw body>` with the destination's secret. The body
 * must be the bytes as received — a parsed and re-serialised one differs in whitespace
 * and fails. More than one `h1` appears while a secret is being rotated, and any that
 * matches will do.
 *
 * The timestamp bounds a replay: Paddle's own SDKs allow five seconds, which is tight
 * for a Worker that might be cold and a clock that might be loose, so this allows five
 * minutes — a captured delivery can only be replayed inside that, and replaying it does
 * nothing anyway, since every event's id is recorded once (`billing_event`).
 *
 * Compared byte for byte in constant time, as every HMAC check should be, with
 * `crypto.subtle.verify` rather than a string equality.
 */
export async function verifyWebhookSignature(
  secret: string,
  header: string | undefined,
  rawBody: string,
  now = Date.now(),
): Promise<boolean> {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const list = parts.get(key) ?? [];
    list.push(part.slice(eq + 1).trim());
    parts.set(key, list);
  }
  const ts = parts.get('ts')?.[0];
  const signatures = parts.get('h1') ?? [];
  if (!ts || !/^\d+$/.test(ts) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const payload = new TextEncoder().encode(`${ts}:${rawBody}`);
  for (const hex of signatures) {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) continue;
    const bytes = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
    if (await crypto.subtle.verify('HMAC', key, bytes, payload)) return true;
  }
  return false;
}

/** The signature Paddle would send for `rawBody` at `ts`, for the tests and the simulator script. */
export async function signWebhook(secret: string, rawBody: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${rawBody}`));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `ts=${ts};h1=${hex}`;
}
