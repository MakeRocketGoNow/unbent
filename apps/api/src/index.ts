import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { AppEnv, RawEnv } from './types.js';
import { withAppUrl } from './lib/app-url.js';
import { sessionMiddleware } from './lib/session.js';
import { health } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { wellKnown } from './routes/well-known.js';
import { ingest } from './routes/ingest.js';
import { notes } from './routes/notes.js';
import { notebooks } from './routes/notebooks.js';
import { tags } from './routes/tags.js';
import { exportRoutes } from './routes/export.js';
import { attachments } from './routes/attachments.js';
import { uploads } from './routes/uploads.js';
import { admin } from './routes/admin.js';
import { search } from './routes/search.js';
import { importEnmlRoutes, importNotebookRoutes, importRoutes } from './routes/import.js';
import { connectedApps } from './routes/connected-apps.js';
import { previewRelay } from './routes/preview-relay.js';
import { mcpRoutes } from './routes/mcp.js';
import { clientErrors } from './routes/client-errors.js';

const app = new Hono<AppEnv>();

app.use('*', logger());

// Resolves the session for every request; individual routes opt into requiring it.
app.use('*', sessionMiddleware);

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

const routes = app
  /**
   * Mounted at the root rather than under /api, because that is where an MCP client looks
   * for them. See routes/well-known.ts, and the matching run_worker_first entries in
   * wrangler.toml without which these paths never reach this Worker at all.
   */
  .route('/', wellKnown)
  /**
   * PostHog's traffic, forwarded so a content blocker does not drop it. At the root for the
   * same reason as the block above — the SDK is pointed at a path, not at /api — and with
   * the same requirement of a matching `run_worker_first` entry in wrangler.toml.
   */
  .route('/', ingest)
  .route('/api', health)
  .route('/api', authRoutes)
  .route('/api', notes)
  .route('/api', notebooks)
  .route('/api', tags)
  .route('/api', exportRoutes)
  .route('/api', attachments)
  .route('/api', uploads)
  .route('/api', admin)
  .route('/api', search)
  .route('/api', importRoutes)
  .route('/api', importNotebookRoutes)
  .route('/api', importEnmlRoutes)
  .route('/api', mcpRoutes)
  .route('/api', connectedApps)
  .route('/api', previewRelay)
  .route('/api', clientErrors);

/** Consumed by the SPA through `hc<AppType>()` for end-to-end types with no codegen. */
export type AppType = typeof routes;

/**
 * The entry point settles `APP_URL` before Hono sees the request, so every route and
 * every Better Auth instance downstream can keep treating it as a plain string. See
 * lib/app-url.ts for what happens when a deployment has not set one.
 */
export default {
  fetch(request: Request, env: RawEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, withAppUrl(env, request), ctx);
  },
};
