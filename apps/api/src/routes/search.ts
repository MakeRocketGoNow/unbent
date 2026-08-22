import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { searchQuerySchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

export const search = new Hono<AppEnv>().get(
  '/search',
  requireAuth,
  withRepos,
  zValidator('query', searchQuerySchema),
  async (c) => {
    const { q, limit } = c.req.valid('query');
    return c.json({ results: await c.get('notes').search(q, limit) });
  },
);
