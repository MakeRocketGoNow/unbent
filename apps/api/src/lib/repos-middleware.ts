import { createMiddleware } from 'hono/factory';
import { storeLimitOf } from './quota.js';
import { reposFor } from './repos.js';
import type { AppEnv } from '../types.js';

/**
 * Binds the verified session's user to their note store and puts the repos on the
 * context.
 *
 * This is the enforcement point for tenant isolation: handlers receive repos already
 * bound to a user's object and never reach for a store or the database themselves, so a
 * request cannot address another account's notes. Must run after requireAuth: it throws
 * rather than silently building an unscoped repo if the user id is missing.
 */
export const withRepos = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get('userId');
  if (!userId) throw new Error('withRepos requires an authenticated session');

  // The store's room from the plan row `requireActivePlan` left on the context, read
  // when a write asks rather than now: the row is there before the route runs, and a
  // route the plan check exempts (a delete, an admin route) has no row and no limit.
  const { notes, attachments } = reposFor(c.env, userId, () => storeLimitOf(c.env, c.get('plan')));
  c.set('notes', notes);
  c.set('attachments', attachments);
  await next();
});
