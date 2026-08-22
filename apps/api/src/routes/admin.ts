import { Hono } from 'hono';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

/**
 * Blob garbage collection.
 *
 * R2 has no foreign keys, so objects outlive their metadata in two cases: deleting a user
 * cascades the D1 rows but leaves the objects behind, and a crash between BLOBS.put and
 * the metadata INSERT leaves an object nothing references. Neither is reachable through
 * the app, so only a sweep like this reclaims the storage.
 *
 * Scoped to the caller's own prefix — this enumerates `users/{me}/` and never the whole
 * bucket, so it cannot see or delete another user's objects even by accident. A future
 * operator-wide sweep would need separate, deliberately privileged handling.
 *
 * Defaults to a dry run; `?apply=1` deletes.
 */
export const admin = new Hono<AppEnv>().post('/admin/gc-blobs', requireAuth, async (c) => {
  const userId = c.get('userId')!;
  const apply = c.req.query('apply') === '1';
  const prefix = `users/${userId}/`;

  const { results } = await c.env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE user_id = ?1`,
  )
    .bind(userId)
    .all<{ r2_key: string }>();
  const referenced = new Set(results.map((r) => r.r2_key));

  const orphans: string[] = [];
  let stored = 0;
  let cursor: string | undefined;

  // Paginate: a large account can hold far more objects than one list() returns.
  for (;;) {
    const page = await c.env.BLOBS.list({ prefix, cursor, limit: 1000 });
    stored += page.objects.length;
    for (const obj of page.objects) {
      if (!referenced.has(obj.key)) orphans.push(obj.key);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }

  if (apply && orphans.length > 0) {
    // R2 accepts up to 1000 keys per delete call.
    for (let i = 0; i < orphans.length; i += 1000) {
      await c.env.BLOBS.delete(orphans.slice(i, i + 1000));
    }
  }

  return c.json({
    referenced: referenced.size,
    stored,
    orphaned: orphans.length,
    deleted: apply ? orphans.length : 0,
    dryRun: !apply,
    keys: orphans.slice(0, 50),
  });
});
