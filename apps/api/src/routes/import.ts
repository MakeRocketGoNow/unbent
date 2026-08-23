import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { importNoteSchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * Import endpoint for ENEX and other bulk sources.
 *
 * Deliberately one note per request rather than a batch: an import of 13,000 notes will be
 * interrupted, and per-note idempotency means a resumed run skips what already landed
 * without any server-side progress tracking. Attachments then go through the normal
 * attachment route, so there is one upload path rather than two.
 */
export const importRoutes = new Hono<AppEnv>().post(
  '/import/note',
  requireAuth,
  withRepos,
  zValidator('json', importNoteSchema),
  async (c) => {
    const input = c.req.valid('json');

    const { id, created } = await c.get('notes').importNote({
      title: input.title,
      body: input.body,
      tags: input.tags,
      notebook: input.notebook,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      contentHash: input.contentHash,
      sourceEnex: input.sourceEnex,
    });

    // `created: false` tells the client this note was already imported, so it can skip
    // re-uploading the attachments too — the expensive part of a resumed run.
    return c.json({ id, created }, created ? 201 : 200);
  },
);
