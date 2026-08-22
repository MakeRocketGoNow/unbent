import { createMiddleware } from 'hono/factory';
import { NotesRepo } from './notes-repo.js';
import { AttachmentsRepo } from './attachments-repo.js';
import type { AppEnv } from '../types.js';

/**
 * Constructs scoped repos from the verified session and puts them on the context.
 *
 * This is the enforcement point for tenant isolation: handlers receive repos already bound
 * to a user id and never reach for `env.DB`, so an unscoped query is not expressible in a
 * route. Must run after requireAuth — it throws rather than silently building an unscoped
 * repo if the user id is missing.
 */
export const withRepos = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get('userId');
  if (!userId) throw new Error('withRepos requires an authenticated session');

  c.set('notes', new NotesRepo(c.env.DB, userId));
  c.set('attachments', new AttachmentsRepo(c.env.DB, userId));
  await next();
});
