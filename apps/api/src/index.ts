import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { AppEnv, RawEnv } from './types.js';
import { withAppUrl } from './lib/app-url.js';
import { StoreUnavailable } from './lib/store-client.js';
import { sweepStores } from './lib/sweep.js';
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

/**
 * The per-account note store, exported so the runtime can construct it. This is one of
 * the two files allowed to import from `cloudflare:workers` as a value (the class module
 * is the other); everywhere else reaches the object through the `USER_STORE` binding and
 * an `import type`, so the Node-run unit tests never load a module that only exists in
 * workerd. A static test in src/store/ holds that line.
 */
export { UserStore } from './store/user-store.js';

const app = new Hono<AppEnv>();

app.use('*', logger());

// Resolves the session for every request; individual routes opt into requiring it.
app.use('*', sessionMiddleware);

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
  /**
   * The daily sweep over every account's note store; see lib/sweep.ts for what it is for.
   * `[triggers]` in wrangler.toml is when. `waitUntil` so the walk is not cut off at the
   * handler's return, and nothing else here needs `APP_URL` settled.
   */
  scheduled(_controller: ScheduledController, env: RawEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(sweepStores(env));
  },
};
