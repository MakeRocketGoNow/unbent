/** Bindings declared in wrangler.toml, plus secrets supplied via `wrangler secret`. */
export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  APP_URL: string;
  /** `wrangler secret put BETTER_AUTH_SECRET`; in dev it comes from .dev.vars. */
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

/** Hono context variables populated by middleware. */
export interface Variables {
  /** Set by sessionMiddleware when a valid session exists. */
  userId?: string;
  user?: SessionUser;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
