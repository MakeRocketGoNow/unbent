import {
  FREE_NOTES,
  FREE_NOTES_FULL_CODE,
  FREE_STORAGE_GB,
  GB,
  PLAN_INACTIVE_CODE,
  fitsFree,
  freeNotesFullMessage,
  planInactiveMessage,
  type HeldCounts,
} from '@unbent/shared';
import { billingOn, type StripeEnv } from './stripe.js';
import { lapsed, type PlanRow } from './plan.js';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { FreeLimits } from '../store/user-store.js';

/**
 * The free plan, on the Worker's side (decided 2026-10-24): which accounts it holds, the
 * limits a write of theirs carries to the store, and the refusal the store's answer is
 * turned back into.
 *
 * An account the free plan holds is one with no plan holding: a trial, a subscription
 * or a comp that ended, where billing is on. Whether it may write is not decided here,
 * since that is what it holds, and what it holds is the store's (`note_counts`): the
 * limits travel with the repos (`writeLimitsOf` in lib/quota.ts), and `UserStore`
 * refuses there, in the call that would write, so no request pays a second call to the
 * object to ask first. Where billing is off nobody is on it, and nothing here is read.
 */

/** The free plan's limits for this account's writes, or null while a plan holds or billing is off. */
export function freeLimitsOf(env: StripeEnv, plan: PlanRow | null | undefined, now = Date.now()): FreeLimits | null {
  if (!billingOn(env) || !plan || !lapsed(plan, now)) return null;
  return { notes: FREE_NOTES, attachmentBytes: FREE_STORAGE_GB * GB };
}

/**
 * A write the free plan refused: `PLAN_INACTIVE` for an account past its limits, which
 * is read-only, or `FREE_NOTES_FULL` for a note that would pass `FREE_NOTES` on one that
 * is not. Rebuilt from the store's `PlanRefusal` (`translateStoreError`), with the
 * sentence that names the account's own numbers, and answered as a 402 with the code
 * (`planRefusedBody`) by the app's error handler, so a route need not know its write
 * carried the limits.
 */
export class PlanRefused extends Error {
  constructor(
    readonly code: typeof PLAN_INACTIVE_CODE | typeof FREE_NOTES_FULL_CODE,
    readonly held: HeldCounts,
    readonly adding: number,
  ) {
    super(code === PLAN_INACTIVE_CODE ? planInactiveMessage(held) : freeNotesFullMessage(held.notes, adding));
    this.name = 'PlanRefused';
  }
}

/**
 * Refuses an account past the free plan before a write that costs something outside
 * the store first: a URL fetched, a body streamed into R2, an upload link minted. The
 * store refuses those too, when the file's row is recorded, but only after the fetch or
 * the upload, which before the free plan a read-only account was never let make: the
 * gate refused it outright. One read of the store's counts (`usage`), and only for an
 * account no plan holds; every other account, and every instance with billing off,
 * reads nothing. An account that fits goes on, and its uploads meet the quota as ever.
 */
export async function refuseIfPastFree(env: StripeEnv, attachments: Pick<AttachmentsRepo, 'usage'>, plan: PlanRow | null | undefined): Promise<number | undefined> {
  if (!freeLimitsOf(env, plan)) return undefined;
  const usage = await attachments.usage();
  const held = { notes: usage.notes, attachmentBytes: usage.attachmentBytes };
  if (!fitsFree(held)) throw new PlanRefused(PLAN_INACTIVE_CODE, held, 0);
  // The files' sum it read, for the quota's check after it (`assertRoom`'s `used`).
  return usage.attachmentBytes;
}

/** The 402's body: the code a client switches on, the sentence, and the counts it was decided on. */
export function planRefusedBody(err: PlanRefused) {
  return { code: err.code, error: err.message, notes: err.held.notes, attachmentBytes: err.held.attachmentBytes };
}
