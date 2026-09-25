import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { searchQuerySchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/** Sets `NotesRepo.scopeDrivenSearchMax` for one request, in the live suite only. */
const SCOPE_MAX_HEADER = 'X-Test-Scope-Driven-Search-Max';

export const search = new Hono<AppEnv>().get(
  '/search',
  requireAuth,
  withRepos,
  zValidator('query', searchQuerySchema),
  async (c) => {
    const { q, limit, tag: tags, notebook, field: fields, from, to } = c.req.valid('query');
    const notes = c.get('notes');
    // The live suite's way to reach both query shapes on the same notes; see
    // `NotesRepo.scopeDrivenSearchMax`. Behind the same local-only flag as the suite's
    // password sign-in, so no deployed instance can be steered by it.
    const forced = c.env.ALLOW_TEST_CREDENTIALS === '1' ? Number(c.req.header(SCOPE_MAX_HEADER)) : NaN;
    if (Number.isFinite(forced)) notes.scopeDrivenSearchMax = forced;
    return c.json({
      results: await notes.search(q, limit, { tags, notebook, fields, from, to }),
    });
  },
);
