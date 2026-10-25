import { Hono, type ErrorHandler } from 'hono';
import { logger } from 'hono/logger';
import { COMPAT_HEADER, COMPAT_LEVEL } from '@unbent/shared/compat';
import type { AppEnv } from './types.js';
import { StoreUnavailable } from './lib/store-client.js';
import { PlanRefused, planRefusedBody } from './lib/free-plan.js';
import { StorageFull, storageFullBody } from './lib/quota.js';
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
 * Every answer states this deploy's compatibility level (`COMPAT_LEVEL`), so a page still
 * running an older build learns it needs a reload from its next request, not only once a
 * new service worker has installed and taken charge of it. A tab that stays in view never
 * asks for a new worker, and a phone resumed after weeks replays its queued writes
 * seconds before one is in. Ahead of everything, health included, since it costs a header.
 */
app.use('*', async (c, next) => {
  await next();
  c.header(COMPAT_HEADER, String(COMPAT_LEVEL));
});

/**
 * Health is mounted ahead of the session check, so it never waits on one. It answers
 * whether the Worker and D1 are reachable, which is all the web app's connectivity check
 * asks of it (`connectivity.ts`: any HTTP answer, within a timeout, means online), and it
 * reads nothing of the user. Behind the session middleware it inherited every stall of the
 * auth store. On 2026-10-13 a wedged session check made health time out too, and the
 * app told a person with a working connection that they were offline. Hono applies
 * middleware only to routes registered after it, so this placement is the exemption. It
 * is outside the `routes` chain below, so `AppType` does not carry it; the web app calls
 * it with a plain `fetch` (connectivity.ts).
 */
app.route('/api', health);

// Resolves the session for every request; individual routes opt into requiring it.
app.use('*', sessionMiddleware);

// Refuses a write from an account whose plan has ended (MAK-108). Global and deny by
// default, with the exemptions named in one place, so a new route is read-only for a
// lapsed account unless someone says otherwise; see lib/plan-middleware.ts.
app.use('/api/*', requireActivePlan);

/**
 * The app's answer to an error no route caught. Exported so a route test can mount it
 * in front of a router and see the status a client gets, which the routers themselves
 * cannot show: a mounted router's errors reach this handler and no other.
 */
export const onAppError: ErrorHandler<AppEnv> = (err, c) => {
  // The note store could not answer and will shortly: the object was reset by a deploy,
  // or is overloaded. A 503 with Retry-After, the same shape `requireAuth` answers when
  // the session cannot be checked, so every client already handles it: the web app
  // retries, and the Android capture worker waits it out rather than failing the share.
  if (err instanceof StoreUnavailable) {
    console.warn('Store unavailable:', err.message);
    c.header('Retry-After', String(err.retryAfterSeconds));
    return c.json({ error: 'Your notes could not be reached right now. Try again shortly.' }, 503);
  }
  // A note write the store refused for its size (MAK-234): the 402 an over-quota upload
  // answers, with the sentence for the store's bound. Answered here rather than in each
  // route that writes a note, since the limit travels with the repo (`withRepos`) and
  // the routes do not know they carry it; the upload routes still catch their own,
  // because they have an object to delete first.
  if (err instanceof StorageFull) return c.json(storageFullBody(err), 402);
  // A write the free plan refused, for the same reason: the free plan's limits travel
  // with the repo, and the store decides. An account past them is read-only (the code
  // the page turns read-only on); one at its count is refused only a new note.
  if (err instanceof PlanRefused) return c.json(planRefusedBody(err), 402);
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal error' }, 500);
};

app.onError(onAppError);

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
   * same reason as the block above (the SDK is pointed at a path, not at /api) and with
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

