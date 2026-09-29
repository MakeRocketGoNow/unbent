/**
 * Tenant-scoped data access to the control plane, which stays in D1.
 *
 * Notes moved to one object per user (see lib/store-client.ts and src/store/), where the
 * database is the user and no query can name another account's rows. What is left in D1
 * is shared across accounts — sessions, OAuth clients, upload links, the account
 * directory — and D1 has no row-level security, so for those tables isolation is still
 * application discipline and a single forgotten `WHERE user_id = ?` is a cross-tenant
 * leak. The defense is structural: a repo is constructed with the user id, every method
 * injects it from the instance, and route handlers receive repos from middleware rather
 * than reaching for `env.DB`. A handler that cannot see the raw database cannot write an
 * unscoped query.
 *
 * Rules every repo method follows:
 *   - scope by user_id even on primary-key lookups; an unguessable id is not an
 *     authorization model
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
