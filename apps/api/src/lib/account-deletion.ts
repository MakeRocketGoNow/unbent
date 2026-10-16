import type { Env } from '../types.js';
import { deleteUserBlobs } from './blobs.js';
import { tombstoneDirectoryRow } from './directory.js';
import { ensureSubscriptionCanceled, paddleOf, type PaddleEnv } from './paddle.js';
import { planRow, updatePlan } from './plan.js';
import { storeFor } from './store-client.js';

type DeletionEnv = Pick<Env, 'BLOBS' | 'DB' | 'USER_STORE' | 'STORE_JURISDICTION'> & PaddleEnv;

/**
 * How long a browser keeps passing `requireAuth` on its signed session cookie without
 * D1 being asked (`cookieCache` in `auth.ts`), and so how long an account deleted with
 * one of its sessions open can still write. Here rather than in `auth.ts` because the
 * sweep has to wait it out before it drops a deleted account's row (`LATE_WRITES_MS` in
 * `sweep.ts`), and the sweep's tests load it in an object, where `auth.ts` and Better
 * Auth do not need to be.
 */
export const SESSION_CACHE_SECONDS = 5 * 60;

/**
 * What deleting an account takes with it beyond the `user` row: its files and its note
 * store. D1 handles its own half (sessions, sign-in accounts, passkeys, OAuth grants and
 * upload links all have `ON DELETE CASCADE`), but R2 has no foreign keys and the notes
 * live in an object of the account's own, and neither can be reached by anything once
 * the account is gone.
 *
 * Two callers, one sequence, so they cannot drift: Better Auth's `deleteUser` hooks in
 * `auth.ts`, for a person deleting their own account, run `clearAccount` before it
 * deletes the row and `tombstoneAccount` after; the operator's delete
 * (`DELETE /api/admin/accounts/:id`) has no Better Auth endpoint around it, so
 * `deleteAccount` deletes the row itself between the two.
 *
 * Files and store before the row, which is the reverse of what `purge-notes` does, and
 * the reversal is the whole design. There the rows go first because a failure afterwards
 * leaves orphans that `gc-blobs` can still reclaim; here the user id the sweep needs is
 * the thing the deletion is about to destroy, so after the row is gone nothing can reach
 * the prefix again. The cost is the mirror image: if this throws, the deletion stops and
 * the account survives carrying attachment rows that point at objects already deleted,
 * or an empty store. That is the recoverable half (the deletion can be asked for again),
 * and it is why the failure is logged rather than swallowed.
 *
 * The object after the files, not before: its rows are what `gc-blobs` reads to know
 * which objects are referenced, and an account that survived a failed file sweep with
 * its rows gone could never find its files again.
 */
export async function clearAccount(env: DeletionEnv, userId: string): Promise<void> {
  await cancelSubscription(env, userId);
  try {
    await deleteUserBlobs(env.BLOBS, userId);
  } catch (err) {
    // The rethrow is what stops the deletion. The log is so a half-swept account can be
    // found afterwards: the id is the only way back to the prefix that still needs
    // finishing, and by then there may be no row to look it up from.
    console.error(`Blob sweep failed for ${userId}; account deletion abandoned:`, err);
    throw err;
  }
  try {
    await storeFor(env, userId).wipe();
  } catch (err) {
    console.error(`Store wipe failed for ${userId}; account deletion abandoned:`, err);
    throw err;
  }
}

/**
 * Ends the account's Paddle subscription before anything of the account goes (MAK-108):
 * a subscription left behind would charge a card for a store that no longer exists, and
 * once the `user` row is gone, nothing here can find it. At once, with no refund for the
 * period's remainder, as the terms say. First, and a refusal stops the deletion: a
 * deletion that silently left a paid subscription running would be worse than one that
 * says to try again, and the row is still there to try again from. The plan row itself
 * goes with the user row's cascade. Nothing to do where billing is off, or for an
 * account that never subscribed, or whose subscription is already canceled.
 *
 * The row is marked canceled as soon as Paddle agrees, so a deletion that then fails at
 * the files or the store is retried without asking Paddle to cancel again. And a cancel
 * Paddle refuses because the subscription is already canceled (the webhook for the
 * first try's cancel not yet landed) is not a reason to keep the account, which is
 * what `ensureSubscriptionCanceled` reads a refusal for before passing it on.
 */
async function cancelSubscription(env: DeletionEnv, userId: string): Promise<void> {
  const paddle = paddleOf(env);
  if (!paddle) return;
  const row = await planRow(env.DB, userId);
  if (!row?.paddleSubscriptionId || row.paddleStatus === 'canceled') return;
  try {
    await ensureSubscriptionCanceled(paddle, row.paddleSubscriptionId);
  } catch (err) {
    console.error(`Paddle subscription ${row.paddleSubscriptionId} for ${userId} could not be cancelled; account deletion abandoned:`, err);
    throw err;
  }
  await updatePlan(env.DB, userId, { paddleStatus: 'canceled', paddleCancelsAt: null });
}

/**
 * Tombstones the directory row once the user row is gone. The row is what the sweep
 * retries the wipe from if the object was reset between the wipe and this, and it is
 * dropped by the sweep once the object reports itself empty. A directory row whose
 * `user` row is missing is treated as tombstoned by the sweep too, so this failing
 * cannot strand an object either, which is why it never throws: by the time it runs
 * the deletion has happened, and must not be reported as failed.
 */
export async function tombstoneAccount(env: DeletionEnv, userId: string): Promise<void> {
  try {
    await tombstoneDirectoryRow(env.DB, userId);
  } catch (err) {
    console.error(`directory tombstone for ${userId} not written; the sweep will treat it as gone:`, err);
  }
}

/**
 * The whole deletion, for a caller with no Better Auth endpoint around it. The row is
 * deleted by hand, as `purge-fixtures` does: everything that refers to `user` in D1
 * cascades, so this is the same deletion Better Auth's `internalAdapter.deleteUser`
 * makes, without the endpoint's own checks (the session's freshness, the emailed link),
 * which are a person's proof that the account is theirs, and are not what lets an
 * operator delete someone else's.
 *
 * Deleting the row ends every session in D1, but not at once in a browser: the session
 * cookie cache (`SESSION_CACHE_SECONDS`) lets a session already open keep passing
 * `requireAuth` until it expires, which is why the page says "within five minutes". The
 * same is true of a person deleting their own account while another of their devices is
 * open. It is not hypothetical: measured against `wrangler dev`, a second session made a
 * note after the deletion and uploaded two files to it, and both reached R2: the store
 * comes back empty on its next call and records them, and only an upload to a note from
 * before the deletion was refused, the wipe having taken the note. (An assistant cannot
 * do the same: every MCP call checks its consent row, which went with the user, and an
 * upload link minted earlier went with it too.)
 *
 * The sweep is what finishes the account. The tombstone turns its wipe on, so the late
 * note goes again; and once `LATE_WRITES_MS` has passed since the tombstone, when no
 * cached session can be left, it deletes whatever is still under the account's prefix
 * and only then drops the row (`sweepOne` in `sweep.ts`). Dropping the row earlier was
 * the gap: with nothing left to name the account, the late files had nothing to find
 * them.
 */
export async function deleteAccount(env: DeletionEnv, userId: string): Promise<void> {
  await clearAccount(env, userId);
  await env.DB.prepare(`DELETE FROM user WHERE id = ?1`).bind(userId).run();
  await tombstoneAccount(env, userId);
}
