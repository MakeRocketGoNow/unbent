import type { BillingConfig } from '@unbent/shared';

/**
 * Stripe, the merchant of record for unbent.app's plan through Managed Payments: the
 * configuration that turns billing on, and the handful of calls the Worker makes to it.
 *
 * Stripe rather than Paddle since 2026-10-22. Paddle was chosen first because at $60 a
 * year sold anywhere, being the seller means registering for VAT from the first
 * European sale, and a merchant of record is the seller and takes that with it. Paddle's
 * seller verification then asked a Minnesota single-member LLC for a government document
 * naming its owner, which Minnesota does not issue, and the review went nowhere. Stripe's
 * Managed Payments is the same arrangement (Stripe, as Link, is the seller of record;
 * it calculates, withholds and remits the tax, handles disputes and transaction-level
 * support) from a US company whose verification matches how a US LLC exists on paper.
 *
 * No SDK: Stripe's is a large package wrapping a form-encoded REST API, and the Worker
 * needs about a dozen of its calls. The shape it was written against is pinned by
 * `STRIPE_API_VERSION`.
 *
 * Billing is one thing, on or off: every setting below, or none of them. An instance that
 * sets none (every fresh checkout, every fork) has no plan to sell, so nothing here
 * runs, every account reads as `active` with no end, and no Plan page is drawn. A
 * half-set configuration is treated as none, the way a half-set OAuth pair is, rather
 * than as a checkout that fails when pressed.
 */
export interface StripeEnv {
  /**
   * The secret key, `sk_test_…` or `rk_test_…` for a sandbox and `sk_live_…` or
   * `rk_live_…` for the live account. Which environment this instance talks to is read
   * off it, so the two cannot be mixed: a test key with live price ids is refused by
   * Stripe, not by anything here, but at least the key says where the request goes. A
   * restricted key (`rk_`) is the right one for production: Customers, Checkout
   * Sessions, Subscriptions and the customer portal to write, Invoices and Charges to
   * read, and nothing else.
   */
  STRIPE_SECRET_KEY?: string;
  /**
   * The webhook endpoint's signing secret, `whsec_…`, which every delivery is signed
   * with. Per endpoint: the sandbox's, the CLI's `stripe listen` and the live account's
   * all differ.
   */
  STRIPE_WEBHOOK_SECRET?: string;
  /** The plan's price, `price_…`, as made in the product catalog: $60 a year. */
  STRIPE_PLAN_PRICE_ID?: string;
  /** The storage add-on's price, `price_…`: $12 a year, sold by quantity. */
  STRIPE_STORAGE_PRICE_ID?: string;
  /**
   * Where the API calls go instead of Stripe, for a stand-in during development and the
   * live suite's checkout test. A deployed instance leaves it unset.
   */
  STRIPE_API_URL?: string;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  planPriceId: string;
  storagePriceId: string;
  environment: 'test' | 'live';
  /** The API's origin, no trailing slash. */
  apiUrl: string;
}

const STRIPE_API = 'https://api.stripe.com';

/**
 * The API version every call is made against, whatever the account's default becomes.
 * The oldest that Managed Payments accepts, and the one that moved a subscription's
 * `current_period_end` onto its items and took `invoice` off a Charge, both of which the
 * code below is written to. Raising it is a change to read the changelog for first.
 */
export const STRIPE_API_VERSION = '2025-03-31.basil';

/** Everything billing needs, or undefined when any of it is missing. */
export function stripeOf(env: StripeEnv): StripeConfig | undefined {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const planPriceId = env.STRIPE_PLAN_PRICE_ID?.trim();
  const storagePriceId = env.STRIPE_STORAGE_PRICE_ID?.trim();
  if (!secretKey || !webhookSecret || !planPriceId || !storagePriceId) return undefined;
  const environment = /^[sr]k_test_/.test(secretKey) ? 'test' : 'live';
  const apiUrl = (env.STRIPE_API_URL?.trim() || STRIPE_API).replace(/\/$/, '');
  return { secretKey, webhookSecret, planPriceId, storagePriceId, environment, apiUrl };
}

/** Whether this instance sells a plan at all. */
export function billingOn(env: StripeEnv): boolean {
  return stripeOf(env) !== undefined;
}

/**
 * What `/api/config` says about billing: that there is a plan to sell, and whether the
 * money is real. Nothing of Stripe's runs in the page (the checkout is Stripe's own
 * page, reached by redirect), so there is no token to hand it; the Plan tab is drawn on
 * this object's presence alone.
 */
export function billingOf(env: StripeEnv): BillingConfig | undefined {
  const stripe = stripeOf(env);
  return stripe ? { environment: stripe.environment } : undefined;
}

// --- The API ---------------------------------------------------------------------------

/** A refusal from Stripe: the status, and its own words from the body, cut short for the log. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    detail: string,
  ) {
    super(`Stripe answered ${status}${code ? ` ${code}` : ''}: ${detail}`);
    this.name = 'StripeError';
  }
}

/** How long one call may take. Stripe answers in well under a second; a hang must not hold a deletion or a checkout open. */
export const STRIPE_TIMEOUT_MS = 10_000;

/**
 * A request body as Stripe takes it: `application/x-www-form-urlencoded`, with nested
 * objects as `a[b]=…` and arrays as `a[0][b]=…`. Booleans are the words, `null` and
 * `undefined` are left out (Stripe reads an empty value as "unset", which is never what
 * a left-out field means here).
 */
export function formEncode(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => add(`${key}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
    } else {
      params.append(key, String(value));
    }
  };
  for (const [k, v] of Object.entries(body)) add(k, v);
  return params.toString();
}

/**
 * One call. A refusal carries `error.type`, `error.code` and `error.message`, which the
 * thrown error keeps for the few callers that branch on a code. The version header pins
 * the API's shape against the one this was written to, rather than to whatever the
 * account's default becomes. A call that does not answer in `STRIPE_TIMEOUT_MS`, or
 * cannot reach Stripe at all, throws a `StripeError` with status 0, so every caller
 * answers it as it answers a refusal: Stripe out of reach, try again shortly, and for a
 * cancel a read-back of the subscription before giving up.
 */
export async function stripeCall<T>(
  stripe: StripeConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${stripe.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${stripe.secretKey}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: formEncode(body) } : {}),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
    // Inside the same bound: the timeout aborts a body that stalls after the headers too.
    text = await res.text();
  } catch (err) {
    throw new StripeError(0, 'unreachable', (err as Error).message);
  }
  let json: T & { error?: { type?: string; code?: string; message?: string } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // Not JSON: a gateway page. The status and the first line of it say enough.
    throw new StripeError(res.status, null, text.slice(0, 200));
  }
  if (!res.ok) throw new StripeError(res.status, json.error?.code ?? json.error?.type ?? null, (json.error?.message ?? text).slice(0, 200));
  return json;
}

/** Stripe's lists: a page of `data`, and whether there is another. */
export interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
}

/**
 * The Stripe customer for an account, made once at the first checkout and kept on the
 * plan row from then on (the row holds the id before the checkout opens, so the first
 * event can find it). `metadata.user_id` is this account's id, so Stripe's side names
 * ours; the join the webhook uses is the customer id on the row. Stripe lets two
 * customers share an address, so there is no "already exists" to catch. The call is
 * keyed on the account and a ten-minute window, so two presses that both read a row
 * with no customer, from two tabs, get the same customer back: otherwise the row keeps
 * the last one written and a checkout made for the other is paid for under a customer
 * the webhook finds no account for. The window and not the account alone because Stripe
 * replays a key's first answer for a day, a passing 500 included, and that would refuse
 * every press for the day. The windows are fixed, not sliding, so two presses either
 * side of an edge still make two customers. Accepted: it needs both tabs pressed within
 * a moment of each other and of the edge, and for both checkouts then to be paid.
 */
export async function createCustomer(stripe: StripeConfig, email: string, userId: string, now = Date.now()): Promise<StripeCustomer> {
  const key = `customer-${userId}-${Math.floor(now / CUSTOMER_KEY_WINDOW_MS)}`;
  return stripeCall<StripeCustomer>(stripe, 'POST', '/v1/customers', { email, metadata: { user_id: userId } }, key);
}

const CUSTOMER_KEY_WINDOW_MS = 10 * 60 * 1000;

export interface StripeCheckoutSession {
  id: string;
  /** Where to send the person: Stripe's hosted page. Null once the session is complete or expired. */
  url: string | null;
  status: string;
  customer: string | null;
  subscription: string | null;
}

/**
 * A Checkout Session for the page to send the person to: the plan, and `storage` add-ons
 * beside it, with Managed Payments on so that Stripe is the seller of record and the
 * tax is its to work out, collect and remit (the page states prices before tax for
 * that reason). Stripe hosts the page; the person comes back to `successUrl` once paid
 * and to `cancelUrl` from the back button. The customer is ours before the session is
 * made, so the plan row holds the id by the time the first event names it, and the
 * page never learns a price id. `client_reference_id` and the subscription's metadata
 * carry the account's id too, so a subscription read on its own still says whose it is.
 *
 * A session is payable for an hour, not Stripe's default day: unlike the overlay it
 * replaced, it outlives the page that opened it, and one paid after what allowed it has
 * changed (a second session, a deleted account) is a subscription the row never holds.
 * The route also expires the customer's earlier sessions before making one
 * (`expireOpenCheckouts`), and so does account deletion.
 *
 * Nothing about tax, payment methods or the customer's address is passed: Managed
 * Payments refuses `automatic_tax`, `tax_id_collection`, `payment_method_types` and
 * `customer_update`, since those are the seller's decisions and Stripe is the seller.
 */
export async function createCheckoutSession(
  stripe: StripeConfig,
  opts: { customerId: string; userId: string; storage: number; successUrl: string; cancelUrl: string },
): Promise<StripeCheckoutSession> {
  const line_items = [{ price: stripe.planPriceId, quantity: 1 }];
  if (opts.storage > 0) line_items.push({ price: stripe.storagePriceId, quantity: opts.storage });
  return stripeCall<StripeCheckoutSession>(stripe, 'POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    managed_payments: { enabled: true },
    customer: opts.customerId,
    client_reference_id: opts.userId,
    line_items,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    subscription_data: { metadata: { user_id: opts.userId } },
    metadata: { user_id: opts.userId },
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_S,
  });
}

/** How long a checkout stays payable. Stripe takes thirty minutes to a day; an hour is time to find a card. */
export const CHECKOUT_LIFETIME_S = 60 * 60;

/**
 * Ends every checkout of the customer's that could still be paid, so no more than one
 * ever can: before a new one is made (a person who went Back from Stripe's page and
 * pressed again has two otherwise, and paying both is two subscriptions, the second
 * kept off the row by `theRows` and renewing every year), and before an account is
 * deleted. A session that completed or expired between the list and the expire is
 * refused with a 400 and is already what this wants; anything else is thrown.
 */
export async function expireOpenCheckouts(stripe: StripeConfig, customerId: string): Promise<void> {
  const page = await stripeCall<StripeList<StripeCheckoutSession>>(
    stripe,
    'GET',
    `/v1/checkout/sessions?customer=${encodeURIComponent(customerId)}&status=open&limit=100`,
  );
  for (const session of page.data) {
    try {
      await stripeCall(stripe, 'POST', `/v1/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {});
    } catch (err) {
      if (!(err instanceof StripeError && err.status === 400)) throw err;
    }
  }
}

export interface StripeSubscriptionItem {
  id: string;
  price: { id: string };
  quantity: number;
  /** The period this item is paid for, unix seconds. Since 2025-03-31.basil the period lives here, not on the subscription. */
  current_period_start: number;
  current_period_end: number;
}

export interface StripeSubscription {
  id: string;
  /** `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid` or `paused`. */
  status: string;
  customer: string;
  /** Unix seconds. What `newestSubscription` orders by. */
  created: number;
  /** A cancellation ahead, unix seconds: set by a cancel at the period's end as much as by a dated one. */
  cancel_at: number | null;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  metadata: Record<string, string>;
  items: StripeList<StripeSubscriptionItem>;
}

export async function getSubscription(stripe: StripeConfig, subscriptionId: string): Promise<StripeSubscription> {
  return stripeCall<StripeSubscription>(stripe, 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/**
 * The customer's newest subscription, or null for a customer who has none. For a row
 * that has a customer but no subscription yet: the first checkout's subscription reaches
 * the row by webhook, and a page re-reading its plan the moment it comes back from the
 * checkout would otherwise find nothing to read until it lands, or never, for a webhook
 * lost for longer than Stripe retries. Newest by creation, whatever its status, so a
 * lapsed one is reported as lapsed rather than hidden; `status=all` is what makes Stripe
 * list canceled ones.
 */
export async function newestSubscription(stripe: StripeConfig, customerId: string): Promise<StripeSubscription | null> {
  const all = await subscriptionsOf(stripe, customerId);
  if (all.length === 0) return null;
  return all.reduce((newest, s) => (s.created > newest.created ? s : newest));
}

/** Every subscription the customer has, whatever its status: one page, since an account has a handful at most. */
export async function subscriptionsOf(stripe: StripeConfig, customerId: string): Promise<StripeSubscription[]> {
  const page = await stripeCall<StripeList<StripeSubscription>>(
    stripe,
    'GET',
    `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`,
  );
  return page.data;
}

/** Statuses Stripe will never charge again: a subscription in one is over, and nothing to cancel. */
export const ENDED_SUBSCRIPTION: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/** The subscription's end of the period paid for: its items' latest, in unix seconds, or null for none. */
export function periodEndOf(sub: StripeSubscription): number | null {
  const ends = sub.items.data.map((i) => i.current_period_end).filter((n) => typeof n === 'number');
  return ends.length ? Math.max(...ends) : null;
}

/**
 * The subscription's storage set to `storage` add-ons. The items are named by their
 * ids, since Stripe reads a bare price as a new item beside the old one: the plan's item
 * stays as it is, the add-on's quantity becomes the new total (two presses of "25 GB
 * more" land as two quantities, not as one applied twice), and an add-on taken to zero
 * is `deleted`. `charge-now` prorates and collects at once (`always_invoice`), with
 * `error_if_incomplete` so a card that fails leaves the subscription as it was and the
 * call fails instead; the quota is then the webhook's to raise the moment the payment is
 * through. `no-charge` makes the same change with nothing billed and nothing credited,
 * for a refund of the add-on: the money has already gone back, and a proration would
 * credit the rest of the period a second time.
 */
export async function setSubscriptionStorage(
  stripe: StripeConfig,
  sub: StripeSubscription,
  storage: number,
  mode: 'charge-now' | 'no-charge',
): Promise<StripeSubscription> {
  const existing = sub.items.data.find((i) => i.price.id === stripe.storagePriceId);
  const items: Array<Record<string, unknown>> = [];
  if (existing) {
    items.push(storage > 0 ? { id: existing.id, quantity: storage } : { id: existing.id, deleted: true });
  } else if (storage > 0) {
    items.push({ price: stripe.storagePriceId, quantity: storage });
  }
  if (items.length === 0) return sub;
  return stripeCall<StripeSubscription>(stripe, 'POST', `/v1/subscriptions/${encodeURIComponent(sub.id)}`, {
    items,
    proration_behavior: mode === 'charge-now' ? 'always_invoice' : 'none',
    ...(mode === 'charge-now' ? { payment_behavior: 'error_if_incomplete' } : {}),
  });
}

/**
 * Ends a subscription at once. For account deletion and a refund of the plan: the
 * account is going, or the period was given back, and a subscription left running would
 * charge a card for a store that no longer exists or a year that was refunded. No
 * refund is made for the period's remainder here; the terms say deletion ends the plan.
 */
export async function cancelSubscriptionNow(stripe: StripeConfig, subscriptionId: string): Promise<void> {
  await stripeCall(stripe, 'DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/**
 * `cancelSubscriptionNow`, for a caller that may be asking twice. Stripe refuses to
 * cancel a subscription that is already canceled, and both callers can be: a deletion
 * retried after the first try's cancel went through, and a refund's event delivered
 * again before the first delivery's `customer.subscription.deleted` has reached the
 * row. A refusal is read once more against the subscription itself before it is passed
 * on, so a cancel that already happened counts as done and a real refusal is still
 * thrown.
 */
export async function ensureSubscriptionCanceled(stripe: StripeConfig, subscriptionId: string): Promise<void> {
  try {
    await cancelSubscriptionNow(stripe, subscriptionId);
  } catch (err) {
    const already =
      err instanceof StripeError &&
      (await getSubscription(stripe, subscriptionId)
        .then((s) => s.status === 'canceled')
        .catch(() => false));
    if (!already) throw err;
  }
}

export interface StripePortalSession {
  url: string;
}

/**
 * A fresh portal link. Each is a short-lived session, so one is made per press and never
 * kept. `payment_method_update` opens the portal on the card form, for the button that
 * names it: under Managed Payments the card can only be changed there (the API refuses
 * `default_payment_method` on these subscriptions). Without a flow the portal opens on
 * its overview, where the invoices and the cancel button are. The configuration is the
 * account's default, made once in the dashboard or by the API (docs/billing.md).
 */
export async function createPortalSession(
  stripe: StripeConfig,
  customerId: string,
  returnUrl: string,
  flow?: 'payment_method_update',
): Promise<StripePortalSession> {
  return stripeCall<StripePortalSession>(stripe, 'POST', '/v1/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
    ...(flow ? { flow_data: { type: flow } } : {}),
  });
}

export interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  /** Whether the whole charge has been refunded. */
  refunded: boolean;
  payment_intent: string | null;
  customer: string | null;
}

export async function getCharge(stripe: StripeConfig, chargeId: string): Promise<StripeCharge> {
  return stripeCall<StripeCharge>(stripe, 'GET', `/v1/charges/${encodeURIComponent(chargeId)}`);
}

export interface StripeDispute {
  id: string;
  charge: string;
  payment_intent: string | null;
  amount: number;
  status: string;
}

export interface StripeInvoiceLine {
  id: string;
  /** The line's amount before tax, in the smallest unit. */
  amount: number;
  quantity: number | null;
  /** Since 2025-03-31.basil the price is under `pricing`, not a `price` object. */
  pricing: { price_details: { price: string } | null } | null;
  /** The tax on this line, as Stripe worked it out, so a refund can be matched with tax in. */
  taxes?: Array<{ amount: number }>;
  period: { start: number; end: number };
}

export interface StripeInvoice {
  id: string;
  customer: string | null;
  status: string;
  /** Since 2025-03-31.basil the subscription an invoice bills is under `parent`. */
  parent: { type: string; subscription_details: { subscription: string } | null } | null;
  lines: StripeList<StripeInvoiceLine>;
}

export async function getInvoice(stripe: StripeConfig, invoiceId: string): Promise<StripeInvoice> {
  return stripeCall<StripeInvoice>(stripe, 'GET', `/v1/invoices/${encodeURIComponent(invoiceId)}`);
}

export interface StripeInvoicePayment {
  id: string;
  invoice: string;
  status: string;
}

/**
 * The invoices a payment paid, by their ids. Since 2025-03-31.basil a Charge no longer
 * names its invoice; the way from a refund or a dispute back to the subscription it was
 * for is the payment intent, then this list, then the invoice's `parent`. Usually one
 * invoice; an empty list is a payment that was not for an invoice at all.
 */
export async function invoicesOfPayment(stripe: StripeConfig, paymentIntentId: string): Promise<string[]> {
  const page = await stripeCall<StripeList<StripeInvoicePayment>>(
    stripe,
    'GET',
    `/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(paymentIntentId)}&status=paid&limit=100`,
  );
  return page.data.map((p) => p.invoice);
}

// --- Webhooks ---------------------------------------------------------------------------

/** How far a webhook's timestamp may be from the clock before it is refused as a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Whether a webhook came from Stripe: `Stripe-Signature` is `t=<unix seconds>,v1=<hex>`,
 * and `v1` is HMAC-SHA256 over `<t>.<raw body>` with the endpoint's signing secret. The
 * body must be the bytes as received: a parsed and re-serialised one differs in
 * whitespace and fails. More than one `v1` appears while a secret is being rolled, and
 * any that matches will do; a `v0` is a scheme this does not read.
 *
 * The timestamp bounds a replay: Stripe's own libraries allow five minutes, which this
 * matches. A captured delivery can only be replayed inside that, and replaying it does
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
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const list = parts.get(key) ?? [];
    list.push(part.slice(eq + 1).trim());
    parts.set(key, list);
  }
  const ts = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!ts || !/^\d+$/.test(ts) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const payload = new TextEncoder().encode(`${ts}.${rawBody}`);
  for (const hex of signatures) {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) continue;
    const bytes = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
    if (await crypto.subtle.verify('HMAC', key, bytes, payload)) return true;
  }
  return false;
}

/**
 * How long a fetched list of Stripe's sending addresses is used before it is asked for
 * again, and how soon an address that is not on it may send it to be asked for early.
 * The second is what lets a change Stripe makes to its addresses reach this isolate in
 * minutes rather than the hour, without letting a stranger knocking on the webhook turn
 * every knock into a fetch.
 */
export const STRIPE_IPS_TTL_MS = 60 * 60 * 1000;
export const STRIPE_IPS_RECHECK_MS = 5 * 60 * 1000;

/**
 * Where Stripe publishes the addresses its webhooks come from: one list for test and
 * live alike, with seven days' notice of a change on its announce list.
 */
export const STRIPE_WEBHOOK_IPS_URL = 'https://stripe.com/files/ips/ips_webhooks.json';

let ipsCache: { cidrs: string[]; at: number } | null = null;
/** When the last fetch failed: a failure waits `STRIPE_IPS_RECHECK_MS` before the next try, as a stranger's knock does. */
let ipsFailedAt = Number.NEGATIVE_INFINITY;

/** For the tests: forget what has been fetched. */
export function forgetStripeIps(): void {
  ipsCache = null;
  ipsFailedAt = Number.NEGATIVE_INFINITY;
}

/**
 * The addresses Stripe sends webhooks from, as Stripe publishes them: a JSON object with
 * a `WEBHOOKS` list of IPv4 addresses. Asked of Stripe rather than written down here,
 * because the file is the source of truth and Stripe changes the list with notice, not
 * with a release of this app. Always Stripe's own address, never `STRIPE_API_URL`: a
 * stand-in API sends no webhooks.
 *
 * Kept in the isolate for `STRIPE_IPS_TTL_MS`. A fetch that fails keeps the list it had,
 * however old, since Stripe's addresses change far less often than a CDN has a bad
 * minute; with nothing kept it answers null, and the webhook is refused as unavailable
 * so Stripe delivers it again. A failure is not tried again for `STRIPE_IPS_RECHECK_MS`:
 * while stripe.com is slow, every delivery and every stranger's request would otherwise
 * wait out its own `STRIPE_TIMEOUT_MS` before the old list answered.
 */
export async function stripeWebhookCidrs(now = Date.now(), refresh = false): Promise<string[] | null> {
  const kept = ipsCache;
  if (kept && now - kept.at < (refresh ? STRIPE_IPS_RECHECK_MS : STRIPE_IPS_TTL_MS)) return kept.cidrs;
  if (now - ipsFailedAt < STRIPE_IPS_RECHECK_MS) return kept?.cidrs ?? null;
  try {
    const res = await fetch(STRIPE_WEBHOOK_IPS_URL, { signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const cidrs = ((await res.json()) as { WEBHOOKS?: unknown }).WEBHOOKS;
    if (!Array.isArray(cidrs) || cidrs.length === 0 || !cidrs.every((c) => typeof c === 'string' && ipv4CidrOf(c))) {
      throw new Error('answered with no addresses');
    }
    ipsCache = { cidrs, at: now };
    return cidrs;
  } catch (err) {
    console.warn(`[billing] Stripe's webhook addresses could not be read:`, (err as Error).message);
    ipsFailedAt = now;
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

/** Whether `address` is inside one of `cidrs`. A bare address is a `/32`. IPv4 only, since that is all Stripe lists. */
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
 * Whether a webhook came from one of Stripe's addresses, before its signature is read:
 * `allowed`, `refused`, or `unknown` when Stripe's list could not be had at all.
 *
 * The signature is the authority and stays so; this is the second lock Stripe's own
 * guidance asks for, and it keeps a stranger's request from costing an HMAC and a D1
 * read. The address is `CF-Connecting-IP`, which Cloudflare sets on every request it
 * delivers and overwrites when a client sends its own. An address not on the list asks
 * for the list again (at most every `STRIPE_IPS_RECHECK_MS`) before it is refused, so a
 * newly added Stripe address is a few refused deliveries, retried, rather than an hour
 * of them.
 *
 * `local` is the test switch (`ALLOW_TEST_CREDENTIALS`), and lets a loopback address
 * through, or none: the live suite signs its own deliveries from this machine, and the
 * CLI's `stripe listen` forwards from it, which are the only real ones a local Worker
 * ever sees. Never set on a deployed instance, which is the line every other local-only
 * path here draws.
 */
export async function webhookSourceOf(address: string | undefined, local: boolean, now = Date.now()): Promise<'allowed' | 'refused' | 'unknown'> {
  if (local && (!address || address === '127.0.0.1' || address === '::1')) return 'allowed';
  if (!address) return 'refused';
  const cidrs = await stripeWebhookCidrs(now);
  if (!cidrs) return 'unknown';
  if (inCidrs(address, cidrs)) return 'allowed';
  const fresh = await stripeWebhookCidrs(now, true);
  return fresh && inCidrs(address, fresh) ? 'allowed' : 'refused';
}

/** The signature Stripe would send for `rawBody` at `ts`, for the tests and the live suite. */
export async function signWebhook(secret: string, rawBody: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${rawBody}`));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${ts},v1=${hex}`;
}
