/**
 * The plan an account is on, as the Worker reports it and the web app draws it (MAK-108).
 *
 * The numbers are unbent.app's offer (MAK-47): one plan, billed yearly, a fortnight free
 * first, and storage sold in blocks on top. They are here rather than in the API because
 * the front page quotes them before anyone has signed in and the Plan page quotes them
 * again beside the buttons, and two copies of a price drift. Paddle holds the prices that
 * are charged; these are what the pages say, and the two have to be changed together.
 *
 * A self-hosted instance never reads them: billing exists only where the Paddle secrets
 * are set (`PADDLE_API_KEY` and the rest), and without them every account is `active`
 * with no end, nothing is refused and no Plan page is drawn.
 */

/** How long a new account has before it must subscribe, with nothing asked of it first. */
export const TRIAL_DAYS = 14;

/** The attachments an account may hold on the plan alone. */
export const BASE_STORAGE_GB = 10;

/** What each storage add-on adds. Sold by the block, never metered. */
export const STORAGE_ADDON_GB = 25;

/** The plan's price, a year at a time. The yearly figure is the only one there is. */
export const PLAN_PRICE_USD = 36;

/** One storage block's price, a year at a time. */
export const STORAGE_ADDON_PRICE_USD = 12;

/**
 * How long an `inactive` account is kept before it is deleted: a year of reading and
 * exporting, with reminders, as the terms say. Stewardship, not cost. The deletion itself
 * is a follow-up to MAK-108; the number is here so the pages that promise it and the job
 * that keeps it cannot disagree.
 */
export const INACTIVE_KEPT_DAYS = 365;

export const GB = 1024 * 1024 * 1024;

/**
 * The most storage blocks one checkout or change may ask for: a terabyte on top, past
 * any archive this app has seen. The API refuses more; the Plan page's checkout lists
 * fewer, and adding storage later goes up to this.
 */
export const MAX_STORAGE_UNITS = 40;

/**
 * The `code` on the 402 a lapsed account's write is answered with, so a client tells it
 * from any other refusal and shows the plan rather than the message. The message beside
 * it is the sentence for a client that does not.
 */
export const PLAN_INACTIVE_CODE = 'PLAN_INACTIVE';
export const PLAN_INACTIVE_MESSAGE =
  'This account is read-only: its plan has ended. Everything still opens, searches and exports, and anything can be deleted; subscribe under Settings → Plan to edit again.';

/** The `code` on the 402 an upload past the plan's storage is answered with. */
export const STORAGE_FULL_CODE = 'STORAGE_FULL';

/**
 * Where an account stands.
 *
 * `trial` and `active` can do everything; `inactive` — a trial that ran out, a
 * subscription that lapsed, a comp that ended — reads, searches, exports and deletes, and
 * is refused every other write with a 402 (`requireActivePlan` in the API). One state for
 * all three ways of lapsing, so there is one code path and one banner.
 */
export type PlanState = 'trial' | 'active' | 'inactive';

/** Who said the account is paid for: Paddle, or an operator who comped it. */
export type PlanSource = 'paddle' | 'comp';

/**
 * The account's plan as `GET /api/me/plan` answers it: what the row says, worked out
 * against the clock, plus what the subscription behind it is doing.
 */
export interface AccountPlan {
  state: PlanState;
  /**
   * When the state ends, in epoch milliseconds, or null for a comp with no end. For a
   * trial, when it runs out; for a subscription, the end of the period paid for, which is
   * when it renews unless `cancelsAt` says otherwise; for an `inactive` account, when it
   * became so.
   */
  until: number | null;
  source: PlanSource | null;
  /** The attachments the account may hold: `BASE_STORAGE_GB` plus the add-ons bought. */
  storageGb: number;
  /** What it holds now, as the account's store counts it. Absent when the store could not say. */
  usedBytes?: number;
  /**
   * The subscription's own state, for the sentence under the plan name: `cancelsAt` is a
   * cancellation already asked for and still ahead, and `pastDue` a renewal Paddle could
   * not collect and is retrying. Null for a trial or a comp, which have none.
   */
  subscription: { status: string; cancelsAt: number | null; pastDue: boolean } | null;
}

/**
 * How Paddle is reached from the page, in `/api/config`: the client-side token Paddle.js
 * initialises with, and which of Paddle's two environments it is a token for. Present only
 * where billing is on; the Plan tab is drawn on the strength of this alone.
 */
export interface BillingConfig {
  environment: 'sandbox' | 'live';
  clientToken: string;
}

/** The bytes an account on `storageGb` may hold. */
export function storageQuotaBytes(storageGb: number): number {
  return storageGb * GB;
}
