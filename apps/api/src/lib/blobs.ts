import { userPrefix } from './repo.js';

/**
 * Bulk R2 housekeeping, shared by every path that deletes objects rather than metadata.
 *
 * R2 has no foreign keys, so anything that removes rows has to remove the objects itself,
 * and each caller meets the same two limits: `list()` returns at most 1000 keys per call
 * and `delete()` accepts at most 1000 per call. That arithmetic lives here because it was
 * written twice before this file existed — once in the admin sweep and once in account
 * deletion — and a limit learned in one copy would not have reached the other.
 */

/** R2 accepts up to 1000 keys per delete call; batch to stay under that limit. */
export async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

/**
 * Deletes every object a user owns.
 *
 * A page at a time, rather than listing the whole account and then deleting what was
 * found. An imported archive is thousands of files, and buffering their keys held the
 * account's entire key space in a Worker's 128MB to no purpose: a page is already
 * independently deletable, and is already at the size `delete()` accepts, so nothing on
 * top of it needs batching. Deleting keys the cursor has passed does not disturb the
 * pagination.
 *
 * The prefix is derived from the user id, so no object outside the account's own
 * directory can be reached from here.
 */
export async function deleteUserBlobs(bucket: R2Bucket, userId: string): Promise<void> {
  const prefix = userPrefix(userId);
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((o) => o.key));
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
}
