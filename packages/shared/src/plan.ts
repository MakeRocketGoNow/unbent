/**
 * The plan an account is on, as the Worker reports it and the web app draws it (MAK-108).
 *
 * The numbers are unbent.app's offer (MAK-47): one plan, billed yearly, a fortnight free
 * first, storage sold in blocks on top, and a free plan underneath for an account small
 * enough to fit it. They are here rather than in the API because
 * the front page quotes them before anyone has signed in and the Plan page quotes them
 * again beside the buttons, and two copies of a price drift. Stripe's catalog holds the
 * prices that are charged; these are what the pages say, and the two have to be changed
 * together.
 *
 * A self-hosted instance never reads them: billing exists only where the Stripe secrets
 * are set (`STRIPE_SECRET_KEY` and the rest), and without them every account is `active`
 * with no end, nothing is refused and no Plan page is drawn.
 */

/** How long a new account has before it must subscribe, with nothing asked of it first. */
export const TRIAL_DAYS = 14;

/** The attachments an account may hold on the plan alone. */
export const BASE_STORAGE_GB = 10;

/**
 * The free plan: what an account with no plan holding may keep and still write (decided
 * 2026-10-24). Not a sign-up path and not a product with a Stripe object: every account
 * starts on the full trial, and when the trial, a subscription or a comp ends, the
 * account is `free` if what it holds fits under these, and `inactive` (read-only) if it
 * does not, until it subscribes or deletes its way under. One rule, decided by what the
 * account holds, for every way of lapsing.
 *
 * Quantity only, never features: notebooks, fields, the offline library, history, an
 * assistant, export and search all stay on, because scale is what the plan sells and the
 * rest is the demo. A hundred notes because Evernote's free tier is fifty notes and one
 * notebook and UpNote's is fifty notes; twice theirs with no cap on notebooks is a
 * sentence the comparison can say plainly. Held at any one time and counted live and
 * trashed together, as Evernote counts it, so the trash is not free overflow: the way
 * under the number is deleting for good and emptying the trash. Restoring from the trash
 * changes no count and is always allowed.
 *
 * The cost is not the constraint (an account this size is cents a month to host); the
 * support inbox, the abuse surface of accounts with no card, and the mail allowance are,
 * which is why the number is small and why an importer who brought a thousand notes into
 * the trial is read-only when it ends, as before: the free plan changes the outcome only
 * for the small account.
 */
export const FREE_NOTES = 100;

/**
 * The free plan's files, in whole gigabytes so it stands where `storage_gb` stands for a
 * paid plan (`AccountPlan.storageGb` reports it while the account has no plan holding)
 * and the store's own room follows from it through `storeLimitBytes`, as it does for
 * every account. A gigabyte is a hundred notes' scans with room to spare; a free account
 * that needs more has outgrown the free plan, which is the point of having one.
 */
export const FREE_STORAGE_GB = 1;

/** What each storage add-on adds. Sold by the block, never metered. */
export const STORAGE_ADDON_GB = 25;

/**
 * The plan's price, a year at a time. The yearly figure is the only one there is.
 *
 * Raising this, or the storage price below, owes every subscriber an email at least 30
 * days before the renewal it applies to: the terms promise it ("Plans and payment" in the
 * web app's `legal/documents.ts`). Nothing sends that mail: it is written by hand, or built
 * first. Changing the price in Stripe's catalog without it breaks the terms.
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
export const PLAN_INACTIVE_MESSAGE = `This account is read-only: its plan has ended, and it holds more than the free plan's ${FREE_NOTES} notes or ${FREE_STORAGE_GB} GB of files. Everything still opens, searches and exports. Delete down to the free plan and empty the trash, or subscribe under Settings → Plan, to edit again.`;

/**
 * The same sentence with the account's own numbers, which the store's refusal has: what
 * it holds against the free plan, so the person knows how far over it is and which of
 * the two to delete. Without them, the general sentence.
 */
export function planInactiveMessage(held?: HeldCounts): string {
  if (!held) return PLAN_INACTIVE_MESSAGE;
  // Only what is over, so the person is not sent to delete files when it is the notes.
  const over: string[] = [];
  if (held.notes > FREE_NOTES) over.push(`${held.notes.toLocaleString('en-US')} notes, more than the free plan's ${FREE_NOTES}`);
  if (held.attachmentBytes > FREE_STORAGE_GB * GB) over.push(`${heldBytes(held.attachmentBytes)} of files, more than the free plan's ${FREE_STORAGE_GB} GB`);
  if (over.length === 0) return PLAN_INACTIVE_MESSAGE;
  return `This account is read-only: its plan has ended, and it holds ${over.join(', and ')}. Everything still opens, searches and exports. Delete down to the free plan and empty the trash, or subscribe under Settings → Plan, to edit again.`;
}

/** Bytes as the plan's sentences say them: whole megabytes under a gigabyte, one decimal above. */
export function heldBytes(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The `code` on the 402 an upload past the plan's storage is answered with. */
export const STORAGE_FULL_CODE = 'STORAGE_FULL';

/**
 * The `code` on the 402 a free account's new note is answered with once it holds
 * `FREE_NOTES`. Its own, rather than the read-only one, because the account is not
 * read-only: every other write still goes, and only a note that would be the hundred and
 * first is refused, so the page keeps the editor open and says this one sentence where
 * the note waits (the outbox keeps it, as it keeps a store-full refusal).
 */
export const FREE_NOTES_FULL_CODE = 'FREE_NOTES_FULL';

/**
 * The sentence for that refusal, with the numbers and the two ways out. In the shared
 * package because the page says the same before it asks: New note on a free account at
 * the number says this rather than making a note the server will refuse.
 */
export function freeNotesFullMessage(held: number, adding = 1): string {
  const room = Math.max(0, FREE_NOTES - held);
  const holds = room > 0 && adding > room ? `${held}, with room for ${room} more` : String(held);
  return `The free plan holds up to ${FREE_NOTES} notes, counting the trash, and this account holds ${holds}. Delete some notes and empty the trash, or subscribe under Settings → Plan for unlimited notes.`;
}

/** What the free plan's rule is read against: the account's notes, live and trashed together, and its files' bytes. */
export interface HeldCounts {
  notes: number;
  attachmentBytes: number;
}

/** Whether an account holding this fits the free plan: at most `FREE_NOTES` notes and `FREE_STORAGE_GB` of files. */
export function fitsFree(held: HeldCounts): boolean {
  return held.notes <= FREE_NOTES && held.attachmentBytes <= FREE_STORAGE_GB * GB;
}

/**
 * Where the plan row stands against the clock: a trial, a plan that holds (a subscription
 * or a comp), or `inactive`, no plan holding (a trial that ran out, a subscription that
 * lapsed, a comp that ended). One state for all three ways of lapsing, so there is one
 * code path. The row's word, and the operator's: `inactive` here says nothing yet about
 * whether the account may write, which is what it holds that decides (`AccountState`).
 */
export type PlanState = 'trial' | 'active' | 'inactive';

/**
 * What the account is, as `GET /api/me/plan` answers it: the row's state, with a lapsed
 * row read against what the account holds. `trial` and `active` can do everything.
 * `free` is a lapsed account that fits the free plan (`fitsFree`): it writes as before,
 * up to `FREE_NOTES` notes and `FREE_STORAGE_GB` of files, with Auto-fill from a pool of
 * its own. `inactive` is a lapsed account that does not: it reads, searches, exports and
 * deletes, and is refused every other write with a 402, until it subscribes or deletes
 * its way under, when it is `free` again with nothing to switch.
 */
export type AccountState = PlanState | 'free';

/** Who said the account is paid for: Stripe, or an operator who comped it. */
export type PlanSource = 'stripe' | 'comp';

/**
 * The account's plan as `GET /api/me/plan` answers it: what the row says, worked out
 * against the clock, plus what the subscription behind it is doing.
 */
export interface AccountPlan {
  state: AccountState;
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
   * when Stripe bills, and the webhook carrying the next period lands after it. Null
   * for a plan with no end; for an `inactive` account, when it became so.
   */
  readOnlyAt: number | null;
  source: PlanSource | null;
  /**
   * The attachments the account may hold: `BASE_STORAGE_GB` plus the add-ons bought, or
   * `FREE_STORAGE_GB` while no plan holds (`free` or `inactive`), which is what its
   * uploads are then held to.
   */
  storageGb: number;
  /** What it holds now, as the account's store counts it. Absent when the store could not say. */
  usedBytes?: number;
  /**
   * Its notes, live and trashed together, as the free plan counts them: read with
   * `usedBytes`, from the same call, and absent with it. The Plan page says from these
   * what a trial's end will leave the account as (`fitsFree`), and meters a free one.
   */
  notes?: number;
  /**
   * How much room the account's own store takes: its notes, the copies their history
   * keeps, the text read from its files, and the search index over them (MAK-234). Read
   * with `usedBytes`, from the same call, and absent with it. Its bound is not sent: the
   * page works it out from `storageGb` with `storeLimitBytes`, as it does the quota.
   */
  storeBytes?: number;
  /**
   * The subscription's own state, for the sentence under the plan name: `cancelsAt` is a
   * cancellation already asked for and still ahead, and `pastDue` a renewal Stripe could
   * not collect and is retrying. Null for a trial or a comp, which have none.
   */
  subscription: { status: string; cancelsAt: number | null; pastDue: boolean } | null;
}

/**
 * That this instance sells a plan, in `/api/config`, and whether the money is real:
 * `test` is a Stripe sandbox, where the checkout takes a test card and moves nothing.
 * Present only where billing is on; the Plan tab is drawn on the strength of this alone.
 * Nothing of Stripe's runs in the page (the checkout is Stripe's own page, reached by
 * redirect), so there is no token here, where Paddle's overlay once needed one.
 */
export interface BillingConfig {
  environment: 'test' | 'live';
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
