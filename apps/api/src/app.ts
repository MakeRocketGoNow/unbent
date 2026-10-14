import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { AppEnv } from './types.js';
import { StoreUnavailable } from './lib/store-client.js';
import { sessionMiddleware } from './lib/session.js';
import { requireActivePlan } from './lib/plan-middleware.js';
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
import { legal } from './routes/legal.js';
import { previewRelay } from './routes/preview-relay.js';
import { mcpRoutes } from './routes/mcp.js';
import { clientErrors } from './routes/client-errors.js';
import { changes } from './routes/changes.js';
import { billing } from './routes/billing.js';

/**
 * The Hono app: every route, and the middleware in front of all of them. Apart from the
 * entry point, so the unit tests can load it; see index.ts.
 */
export const app = new Hono<AppEnv>();

app.use('*', logger());

/**
 * Health is mounted ahead of the session check, so it never waits on one. It answers
 * whether the Worker and D1 are reachable, which is all the web app's connectivity check
 * asks of it (`connectivity.ts`: any HTTP answer, within a timeout, means online), and it
 * reads nothing of the user. Behind the session middleware it inherited every stall of the
 * auth store — on 2026-10-13 a wedged session check made health time out too, and the
 * app told a person with a working connection that they were offline. Hono applies
 * middleware only to routes registered after it, so this placement is the exemption.
 */
app.route('/api', health);

// Resolves the session for every request; individual routes opt into requiring it.
app.use('*', sessionMiddleware);

// Refuses a write from an account whose plan has ended (MAK-108). Global and deny by
// default, with the exemptions named in one place, so a new route is read-only for a
// lapsed account unless someone says otherwise; see lib/plan-middleware.ts.
app.use('/api/*', requireActivePlan);

app.onError((err, c) => {
  // The note store could not answer and will shortly — the object was reset by a deploy,
  // or is overloaded. A 503 with Retry-After, the same shape `requireAuth` answers when
  // the session cannot be checked, so every client already handles it: the web app
  // retries, and the Android capture worker waits it out rather than failing the share.
  if (err instanceof StoreUnavailable) {
    console.warn('Store unavailable:', err.message);
    c.header('Retry-After', String(err.retryAfterSeconds));
    return c.json({ error: 'Your notes could not be reached right now. Try again shortly.' }, 503);
  }
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
  .route('/api', legal)
  .route('/api', previewRelay)
  .route('/api', clientErrors)
  .route('/api', changes)
  .route('/api', billing);

/** Consumed by the SPA through `hc<AppType>()` for end-to-end types with no codegen; re-exported by index.ts. */
export type AppType = typeof routes;

