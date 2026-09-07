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
