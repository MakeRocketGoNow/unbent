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

/**
 * The plan's price, a year at a time. The yearly figure is the only one there is.
 *
 * Raising this, or the storage price below, owes every subscriber an email at least 30
 * days before the renewal it applies to: the terms promise it ("Plans and payment" in the
 * web app's `legal/documents.ts`). Nothing sends that mail: it is written by hand, or built
 * first. Changing the price in Paddle's catalog without it breaks the terms.
 */
export const PLAN_PRICE_USD = 60;

/** One storage block's price, a year at a time. The same 30 days' notice applies. */
export const STORAGE_ADDON_PRICE_USD = 12;

/**
 * How long an `inactive` account is kept before it *may* be deleted: at least a year of
 * reading and exporting, as the terms say ("Plans and payment").
 *
 * "May", never "will", and decided on 14 October 2026 (MAK-47): the pages, the mail and
 * the terms reserve the right and nothing deletes on a timer. The product's promise is
 * that nothing is held hostage, and a cron job that removes a paperless archive because
 * its owner missed a year of mail is the worst thing it could do to someone; a read-only
 * account costs almost nothing to keep. The right is there for an abandoned trial that
 * uploaded a lot, or abuse, decided by a person. Anything built later should be scoped to
 * those, and must send the reminder to export first, which every one of these promises.
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
 * `trial` and `active` can do everything; `inactive` (a trial that ran out, a
 * subscription that lapsed, a comp that ended) reads, searches, exports and deletes, and
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
  /**
   * When the account turns read-only unless something changes first, which a client
   * locks on rather than `until`: the same instant for a trial or a comp, and for a
   * renewing subscription its end plus the server's renewal grace: the period's end is
   * when Paddle bills, and the webhook carrying the next period lands after it. Null
   * for a plan with no end; for an `inactive` account, when it became so.
   */
  readOnlyAt: number | null;
  source: PlanSource | null;
  /** The attachments the account may hold: `BASE_STORAGE_GB` plus the add-ons bought. */
  storageGb: number;
  /** What it holds now, as the account's store counts it. Absent when the store could not say. */
  usedBytes?: number;
  /**
   * How much room the account's own store takes: its notes, the copies their history
   * keeps, the text read from its files, and the search index over them (MAK-234). Read
   * with `usedBytes`, from the same call, and absent with it. Its bound is not sent: the
   * page works it out from `storageGb` with `storeLimitBytes`, as it does the quota.
   */
  storeBytes?: number;
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

const MB = 1024 * 1024;

/**
 * How much room the account's own store may take (MAK-234): a floor, plus a tenth of
 * the quota on files.
 *
 * The quota bounds the bytes in R2 and nothing else; what the store holds (note bodies,
 * the copies the history keeps of them, the text extracted from files, the search
 * index) had no bound at all, and a loop writing maximum-size notes held tens of
 * gigabytes on a trial with no card (measured 2026-10-16: a maximum note costs about
 * 2.2 MB of store, so ten thousand of them are 22 GB). Store bytes are also the dearer
 * kind, about thirteen times R2's price per gigabyte-month, so a tenth of the quota in
 * the store costs what the whole quota does in the bucket: within what the plan is
 * priced for, and no more.
 *
 * The floor is for the archive this app is for, whose store is mostly its files' text.
 * A real one measured at a few percent of its files (21.8 MB of text in a 46 MB store
 * for 2,415 files, 2026-09-29), so a tenth of the quota is a wide margin for text
 * that comes with files; the floor is the margin for an account whose files are
 * small and whose notes are not, and for the history of a long-kept archive. Nothing
 * this app does on purpose comes near the sum, and the refusal must never fire for an
 * account that only filed what it scanned. One number for every plan rather than a
 * setting, as the quota's blocks are: an operator who finds it wrong changes it here.
 *
 * Note writes and a file's text are held to it in the API (`NotesRepo`,
 * `AttachmentsRepo`): deleting for good, emptying the trash and clearing a note's
 * history are the way back under. Trashing is allowed too, and frees nothing until the
 * trash is emptied. The text is bounded too because the quota on files counts bytes in
 * the bucket, and a text layer sent for a file is as long as the sender makes it,
 * whatever the file's size.
 *
 * Here rather than in the API because the limit follows the quota: the Plan page works
 * out what a smaller plan would allow before offering to remove a storage block, as it
 * does for the quota itself with `storageQuotaBytes`, and two copies of the number
 * would drift.
 */
export const STORE_FLOOR_BYTES = 512 * MB;

export function storeLimitBytes(quotaBytes: number): number {
  return STORE_FLOOR_BYTES + Math.floor(quotaBytes / 10);
}
