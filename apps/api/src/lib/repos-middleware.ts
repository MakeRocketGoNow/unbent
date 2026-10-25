import { createMiddleware } from 'hono/factory';
import { billingOn } from './stripe.js';
import { writeLimitsFor, writeLimitsOf } from './quota.js';
import { reposFor } from './repos.js';
import type { WriteLimits } from '../store/user-store.js';
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

  // The store's room (MAK-234) and the free plan's limits, asked for only when a write
  // wants them. From the plan row `requireActivePlan` left on the context where there is
  // one; a route the plan check exempts has none, and a bounded write on one reads the
  // row itself, once per request. The browser's text layer (`PUT …/text`) is the case
  // that matters: exempt, so a lapsed account's pass does not fail on every open, and a
  // write of up to half a million characters whatever the file's size, which a missing
  // row left unbounded (found in review). A delete never asks, so the exempt deletes
  // still read nothing.
  let read: Promise<WriteLimits | null> | undefined;
  const { notes, attachments } = reposFor(c.env, userId, () => {
    const row = c.get('plan');
    if (row || !billingOn(c.env)) return writeLimitsOf(c.env, row);
    return (read ??= writeLimitsFor(c.env, c.env.DB, userId).catch((err: unknown) => {
      read = undefined;
      throw err;
    }));
  });
  c.set('notes', notes);
  c.set('attachments', attachments);
  await next();
});
