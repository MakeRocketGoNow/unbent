import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export const health = new Hono<AppEnv>().get('/health', async (c) => {
  // Actually touch D1 — a health check that does not exercise its bindings is decoration.
  const started = Date.now();
  let db: 'ok' | 'error' = 'ok';
  let dbError: string | undefined;

  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
  } catch (err) {
    db = 'error';
    dbError = (err as Error).message;
  }

  const status = db === 'ok' ? 200 : 503;
  return c.json(
    {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      ...(dbError ? { dbError } : {}),
      latencyMs: Date.now() - started,
    },
    status,
  );
});
