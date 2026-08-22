import { Hono } from 'hono';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { exportZipStream } from '../lib/export.js';
import type { AppEnv } from '../types.js';

export const exportRoutes = new Hono<AppEnv>().get(
  '/export',
  requireAuth,
  withRepos,
  (c) => {
    const stamp = new Date().toISOString().slice(0, 10);

    // Returned immediately, before any note is read: the archive is produced as the
    // client consumes it, so nothing is ever held in the Worker's 128MB of memory.
    return new Response(exportZipStream({ notes: c.get('notes') }), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="unbent-export-${stamp}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  },
);
