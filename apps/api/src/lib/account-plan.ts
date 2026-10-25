import type { AccountPlan } from '@unbent/shared';
import { noWriteLimits } from './notes-repo.js';
import { accountPlanOf, lapsed, type PlanRow } from './plan.js';
import { reposFor } from './repos.js';
import type { StoreUsage } from '../store/user-store.js';
import type { Env } from '../types.js';

/**
 * The account's plan as a client is told it (`AccountPlan`), with the account's store
 * asked what it holds where the answer needs it.
 *
 * Always for a lapsed row: whether an account with no plan holding is `free` or
 * `inactive` is what it holds (`accountStateOf`), so the row alone cannot answer, and an
 * answer that guessed would lock a free account's editor or open a read-only one's. The
 * call is one to the object (`usage`, the sweep's read: the counts row and the database
 * size), made only for those accounts and only on this read, never on a write, where the
 * store decides from the limits the repos carry. A store that cannot answer fails the
 * read (a 503 the page waits out, keeping the answer it had) rather than say a state it
 * does not know.
 *
 * And with `figures`, for the Plan page's meters: then the figures ride along, and a
 * store that cannot answer leaves them out for an account whose state does not depend
 * on them, since the plan is still the plan.
 */
export async function accountPlanFor(
  env: Pick<Env, 'USER_STORE' | 'STORE_JURISDICTION'>,
  userId: string,
  row: PlanRow,
  now: number,
  opts: { figures?: boolean } = {},
): Promise<AccountPlan> {
  const needed = lapsed(row, now);
  if (!needed && !opts.figures) return accountPlanOf(row, now);
  let usage: StoreUsage | undefined;
  try {
    usage = await reposFor(env, userId, noWriteLimits).attachments.usage();
  } catch (err) {
    if (needed) throw err;
    console.warn(`[billing] storage used for user=${userId} unavailable:`, (err as Error).message);
  }
  if (!usage) return accountPlanOf(row, now);
  const plan = accountPlanOf(row, now, { notes: usage.notes, attachmentBytes: usage.attachmentBytes });
  return opts.figures ? { ...plan, usedBytes: usage.attachmentBytes, storeBytes: usage.databaseSize, notes: usage.notes } : plan;
}
