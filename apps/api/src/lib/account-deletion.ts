import type { Env } from '../types.js';
import { deleteUserBlobs } from './blobs.js';
import { tombstoneDirectoryRow } from './directory.js';
import { storeFor } from './store-client.js';

type DeletionEnv = Pick<Env, 'BLOBS' | 'DB' | 'USER_STORE' | 'STORE_JURISDICTION'>;

/**
 * What deleting an account takes with it beyond the `user` row: its files and its note
 * store. D1 handles its own half — sessions, sign-in accounts, passkeys, OAuth grants and
 * upload links all have `ON DELETE CASCADE` — but R2 has no foreign keys and the notes
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
 * or an empty store. That is the recoverable half — the deletion can be asked for again
 * — and it is why the failure is logged rather than swallowed.
 *
 * The object after the files, not before: its rows are what `gc-blobs` reads to know
 * which objects are referenced, and an account that survived a failed file sweep with
 * its rows gone could never find its files again.
 */
export async function clearAccount(env: DeletionEnv, userId: string): Promise<void> {
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
 * Tombstones the directory row once the user row is gone. The row is what the sweep
 * retries the wipe from if the object was reset between the wipe and this, and it is
 * dropped by the sweep once the object reports itself empty. A directory row whose
 * `user` row is missing is treated as tombstoned by the sweep too, so this failing
 * cannot strand an object either — which is why it never throws: by the time it runs
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
 * makes, without the endpoint's own checks — the session's freshness, the emailed link —
 * which are a person's proof that the account is theirs, and are not what lets an
 * operator delete someone else's.
 */
export async function deleteAccount(env: DeletionEnv, userId: string): Promise<void> {
  await clearAccount(env, userId);
  await env.DB.prepare(`DELETE FROM user WHERE id = ?1`).bind(userId).run();
  await tombstoneAccount(env, userId);
}
