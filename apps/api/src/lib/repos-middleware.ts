import { createMiddleware } from 'hono/factory';
import { reposFor } from './repos.js';
import type { AppEnv } from '../types.js';

/**
 * Binds the verified session's user to their note store and puts the repos on the
 * context.
 *
 * This is the enforcement point for tenant isolation: handlers receive repos already
 * bound to a user's object and never reach for a store or the database themselves, so a
 * request cannot address another account's notes. Must run after requireAuth — it throws
 * rather than silently building an unscoped repo if the user id is missing.
 */
export const withRepos = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get('userId');
  if (!userId) throw new Error('withRepos requires an authenticated session');

  const { notes, attachments } = reposFor(c.env, userId);
  c.set('notes', notes);
  c.set('attachments', attachments);
  await next();
});
