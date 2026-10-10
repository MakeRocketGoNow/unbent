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
