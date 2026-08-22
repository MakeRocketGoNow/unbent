import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { AppEnv } from './types.js';
import { sessionMiddleware } from './lib/session.js';
import { health } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { notes } from './routes/notes.js';
import { exportRoutes } from './routes/export.js';
import { attachments } from './routes/attachments.js';

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
  .route('/api', health)
  .route('/api', authRoutes)
  .route('/api', notes)
  .route('/api', exportRoutes)
  .route('/api', attachments);

/** Consumed by the SPA through `hc<AppType>()` for end-to-end types with no codegen. */
export type AppType = typeof routes;

export default app;
