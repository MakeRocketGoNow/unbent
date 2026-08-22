/** Bindings declared in wrangler.toml, plus secrets supplied via `wrangler secret`. */
export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  APP_URL: string;
}

/** Hono context variables populated by middleware. */
export interface Variables {
  // Populated in Phase 1 by the session middleware.
  userId?: string;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
