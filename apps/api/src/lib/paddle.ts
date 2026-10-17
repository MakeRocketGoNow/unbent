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
 * sets none (every fresh checkout, every fork) has no plan to sell, so nothing here
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
   * sandbox and `live_…` for live. Public by design (it ships in the page) and in
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
 * customer made for this address some other way (by hand in the dashboard, by a
 * checkout before this code stored the id) is found by listing the email rather than
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
  /**
   * The lines as billed, each with the `txnitm_` id an adjustment's items name: the one
   * way back from a refund to the price it refunded. On a read of the transaction; a
   * `transaction.completed` event carries it too, but nothing here reads it from one.
   */
  details?: { line_items: PaddleLineItem[] } | null;
}

export interface PaddleLineItem {
  id: string;
  price_id: string;
  quantity: number;
}

export async function getTransaction(paddle: PaddleConfig, transactionId: string): Promise<PaddleTransaction> {
  return paddleCall<PaddleTransaction>(paddle, 'GET', `/transactions/${transactionId}`);
}

/**
 * An adjustment: money given back on a transaction after it was paid (a refund, a
 * credit, a chargeback). The webhook reads a refund of the plan as the end of the
 * subscription (`refundEffectOf` in billing-events.ts), since Paddle itself leaves the
 * subscription active and renewing. `items` name the transaction's lines by `txnitm_`
 * id, not by price, so telling the plan's refund from the add-on's takes a read of the
 * transaction.
 */
export interface PaddleAdjustment {
  id: string;
  action: string;
  /** `full` is the whole transaction; `partial` is the lines in `items`. */
  type: 'full' | 'partial';
  /** `pending_approval`, `approved`, `rejected` or `reversed`. */
  status: string;
  transaction_id: string;
  subscription_id: string | null;
  customer_id: string;
  items: Array<{ id: string; item_id: string; type: string; amount: string | null }>;
}

/**
 * A transaction for the checkout to open: the plan, and `storage` add-ons with it. Made
 * here rather than by Paddle.js from a price list so that the customer is ours before
 * the checkout opens (the plan row holds the id by then) and so that the page never
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
 * would otherwise find nothing to read until it lands, or never, for a webhook lost for
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
 * period now. The items are the whole list (Paddle reads an item left out as removed),
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

/**
 * `cancelSubscriptionNow`, for a caller that may be asking twice. Paddle refuses to
 * cancel a subscription that is already canceled, and both callers can be: a deletion
 * retried after the first try's cancel went through, and a refund's event delivered
 * again before the first delivery's `subscription.canceled` has reached the row. A
 * refusal is read once more against the subscription itself before it is passed on, so
 * a cancel that already happened counts as done and a real refusal is still thrown.
 */
export async function ensureSubscriptionCanceled(paddle: PaddleConfig, subscriptionId: string): Promise<void> {
  try {
    await cancelSubscriptionNow(paddle, subscriptionId);
  } catch (err) {
    const already =
      err instanceof PaddleError &&
      (await getSubscription(paddle, subscriptionId)
        .then((s) => s.status === 'canceled')
        .catch(() => false));
    if (!already) throw err;
  }
}

/**
 * The storage add-on taken off a subscription with nothing billed and nothing credited,
 * for a refund of the add-on's charge: the money has already gone back through the
 * adjustment, and `setSubscriptionStorage`'s `prorated_immediately` would credit the
 * rest of the period a second time. The plan item stays, since the list is the whole
 * subscription. `do_not_bill` is the mode Paddle offers for exactly this.
 */
export async function removeSubscriptionStorage(paddle: PaddleConfig, subscriptionId: string): Promise<PaddleSubscription> {
  return paddleCall<PaddleSubscription>(paddle, 'PATCH', `/subscriptions/${subscriptionId}`, {
    items: [{ price_id: paddle.planPriceId, quantity: 1 }],
    proration_billing_mode: 'do_not_bill',
  });
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
 * must be the bytes as received: a parsed and re-serialised one differs in whitespace
 * and fails. More than one `h1` appears while a secret is being rotated, and any that
 * matches will do.
 *
 * The timestamp bounds a replay: Paddle's own SDKs allow five seconds, which is tight
 * for a Worker that might be cold and a clock that might be loose, so this allows five
 * minutes: a captured delivery can only be replayed inside that, and replaying it does
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

/**
 * How long a fetched list of Paddle's sending addresses is used before it is asked for
 * again, and how soon an address that is not on it may send it to be asked for early.
 * The second is what lets a change Paddle makes to its addresses reach this isolate in
 * minutes rather than the hour, without letting a stranger knocking on the webhook turn
 * every knock into a fetch.
 */
export const PADDLE_IPS_TTL_MS = 60 * 60 * 1000;
export const PADDLE_IPS_RECHECK_MS = 5 * 60 * 1000;

const ipsCache = new Map<PaddleConfig['environment'], { cidrs: string[]; at: number }>();

/** For the tests: forget what has been fetched. */
export function forgetPaddleIps(): void {
  ipsCache.clear();
}

/**
 * The addresses Paddle sends webhooks from, as Paddle publishes them at `/ips`: a list of
 * IPv4 CIDRs, each a `/32` today. Asked of Paddle rather than written down here, because
 * the endpoint is the source of truth and Paddle changes the list with notice, not with a
 * release of this app. Always the environment's own origin, never `PADDLE_API_URL`: a
 * stand-in API sends no webhooks, and the sandbox's addresses differ from live's.
 *
 * Kept in the isolate for `PADDLE_IPS_TTL_MS`. A fetch that fails keeps the list it had,
 * however old, since Paddle's addresses change far less often than its API has a bad
 * minute; with nothing kept it answers null, and the webhook is refused as unavailable
 * so Paddle delivers it again.
 */
export async function paddleWebhookCidrs(
  environment: PaddleConfig['environment'],
  now = Date.now(),
  refresh = false,
): Promise<string[] | null> {
  const kept = ipsCache.get(environment);
  if (kept && now - kept.at < (refresh ? PADDLE_IPS_RECHECK_MS : PADDLE_IPS_TTL_MS)) return kept.cidrs;
  try {
    const res = await fetch(`${environment === 'sandbox' ? SANDBOX_API : LIVE_API}/ips`, {
      signal: AbortSignal.timeout(PADDLE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const cidrs = ((await res.json()) as { data?: { ipv4_cidrs?: unknown } }).data?.ipv4_cidrs;
    if (!Array.isArray(cidrs) || cidrs.length === 0 || !cidrs.every((c) => typeof c === 'string' && ipv4CidrOf(c))) {
      throw new Error('answered with no addresses');
    }
    ipsCache.set(environment, { cidrs, at: now });
    return cidrs;
  } catch (err) {
    console.warn(`[billing] Paddle's ${environment} webhook addresses could not be read:`, (err as Error).message);
    return kept?.cidrs ?? null;
  }
}

function ipv4Of(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

function ipv4CidrOf(cidr: string): { base: number; bits: number } | null {
  const [address, length = '32'] = cidr.split('/');
  const base = ipv4Of(address ?? '');
  const bits = Number(length);
  if (base === null || !/^\d{1,2}$/.test(length) || bits > 32) return null;
  return { base, bits };
}

/** Whether `address` is inside one of `cidrs`. IPv4 only, since that is all Paddle lists. */
export function inCidrs(address: string, cidrs: readonly string[]): boolean {
  const ip = ipv4Of(address);
  if (ip === null) return false;
  return cidrs.some((cidr) => {
    const range = ipv4CidrOf(cidr);
    if (!range) return false;
    // 2 ** (32 - bits) rather than a shift: a JavaScript shift is 32-bit signed, and the
    // top half of the address space would come out negative.
    const size = 2 ** (32 - range.bits);
    return Math.floor(ip / size) === Math.floor(range.base / size);
  });
}

/**
 * Whether a webhook came from one of Paddle's addresses, before its signature is read:
 * `allowed`, `refused`, or `unknown` when Paddle's list could not be had at all.
 *
 * The signature is the authority and stays so; this is the second lock Paddle asks for,
 * and it keeps a stranger's request from costing an HMAC and a D1 read. The address is
 * `CF-Connecting-IP`, which Cloudflare sets on every request it delivers and overwrites
 * when a client sends its own. An address not on the list asks for the list again (at
 * most every `PADDLE_IPS_RECHECK_MS`) before it is refused, so a newly added Paddle
 * address is a few refused deliveries, retried, rather than an hour of them.
 *
 * `local` is the test switch (`ALLOW_TEST_CREDENTIALS`), and lets a loopback address
 * through, or none: the live suite signs its own deliveries from this machine, and a
 * tunnel's are the only real ones a local Worker ever sees. Never set on a deployed
 * instance, which is the line every other local-only path here draws.
 */
export async function webhookSourceOf(
  paddle: PaddleConfig,
  address: string | undefined,
  local: boolean,
  now = Date.now(),
): Promise<'allowed' | 'refused' | 'unknown'> {
  if (local && (!address || address === '127.0.0.1' || address === '::1')) return 'allowed';
  if (!address) return 'refused';
  const cidrs = await paddleWebhookCidrs(paddle.environment, now);
  if (!cidrs) return 'unknown';
  if (inCidrs(address, cidrs)) return 'allowed';
  const fresh = await paddleWebhookCidrs(paddle.environment, now, true);
  return fresh && inCidrs(address, fresh) ? 'allowed' : 'refused';
}

/** The signature Paddle would send for `rawBody` at `ts`, for the tests and the simulator script. */
export async function signWebhook(secret: string, rawBody: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${rawBody}`));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `ts=${ts};h1=${hex}`;
}
