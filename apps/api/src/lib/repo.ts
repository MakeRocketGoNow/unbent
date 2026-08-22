/**
 * Tenant-scoped data access.
 *
 * D1 has no row-level security, so isolation is entirely application discipline and a
 * single forgotten `WHERE user_id = ?` is a cross-tenant leak. The defense is structural:
 * a repo is constructed with the user id, every method injects it from the instance, and
 * route handlers receive repos from middleware rather than reaching for `env.DB`. A
 * handler that cannot see the raw database cannot write an unscoped query.
 *
 * Rules every repo method follows:
 *   - scope by user_id even on primary-key lookups; an unguessable id is not an
 *     authorization model
 *   - check ownership by joining through to `notes` rather than trusting an id from a URL
 *   - derive R2 keys from the session, never from client input, so a wrong query still
 *     cannot reach another user's objects
 */

/** R2 key prefix owned by a user. Always derived from the verified session. */
export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}

/**
 * Base for every scoped repo. Subclasses read `this.userId` and must never accept a user
 * id as a method parameter — that would reintroduce exactly the mistake this prevents.
 */
export abstract class ScopedRepo {
  constructor(
    protected readonly db: D1Database,
    protected readonly userId: string,
  ) {
    if (!userId) throw new Error('Refusing to construct a repo without a user id');
  }

  /** R2 key prefix for this user's objects. */
  protected get blobPrefix(): string {
    return userPrefix(this.userId);
  }
}
