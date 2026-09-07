import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { AppEnv } from './types.js';
import { sessionMiddleware } from './lib/session.js';
import { health } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { wellKnown } from './routes/well-known.js';
import { notes } from './routes/notes.js';
import { notebooks } from './routes/notebooks.js';
import { exportRoutes } from './routes/export.js';
import { attachments } from './routes/attachments.js';
import { admin } from './routes/admin.js';
import { search } from './routes/search.js';
import { importEnmlRoutes, importRoutes } from './routes/import.js';
import { connectedApps } from './routes/connected-apps.js';
import { mcpRoutes } from './routes/mcp.js';

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
  .route('/api', health)
  .route('/api', authRoutes)
  .route('/api', notes)
  .route('/api', notebooks)
  .route('/api', exportRoutes)
  .route('/api', attachments)
  .route('/api', admin)
  .route('/api', search)
  .route('/api', importRoutes)
  .route('/api', importEnmlRoutes)
  .route('/api', mcpRoutes)
  .route('/api', connectedApps);

/** Consumed by the SPA through `hc<AppType>()` for end-to-end types with no codegen. */
export type AppType = typeof routes;

export default app;
