import type { NotesRepo } from './lib/notes-repo.js';
import type { AttachmentsRepo } from './lib/attachments-repo.js';

/** Bindings declared in wrangler.toml, plus secrets supplied via `wrangler secret`. */
export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  /**
   * Workers AI, for extracting a PDF's text on upload. Bound in production only — see
   * wrangler.toml — so it is optional here, and its absence means the browser does the
   * extracting, as it did before.
   */
  AI?: Ai;
  APP_URL: string;
  /** `wrangler secret put BETTER_AUTH_SECRET`; in dev it comes from .dev.vars. */
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  /** Optional second audience, when the Android app asks for its own client id. */
  GOOGLE_ANDROID_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /**
   * '1' offers email-and-password sign-in. For self-hosted instances, which cannot
   * register OAuth callbacks with Google or GitHub on anyone's behalf; unbent.app leaves
   * it unset.
   */
  AUTH_PASSWORD?: string;
  /** '1' enables password auth so the isolation suite can mint sessions. Local only. */
  ALLOW_TEST_CREDENTIALS?: string;
  /**
   * Comma-separated emails allowed to create an account. Unset or empty means anyone
   * can sign up, which is fine locally but not for a deployed instance.
   */
  ALLOWED_EMAILS?: string;
  /**
   * Resend credentials, for password reset mail. Both must be set for mail to be sent;
   * without them a reset link is logged rather than delivered, which is what local
   * development wants and what a deployed instance must not do. See lib/email.ts.
   */
  RESEND_API_KEY?: string;
  /** The From address, e.g. "Unbent <noreply@mail.unbent.app>". Its domain must be verified. */
  EMAIL_FROM?: string;
  /**
   * Optional Reply-To, for when the sending domain is not a mailbox. See lib/email.ts.
   */
  EMAIL_REPLY_TO?: string;
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
  /** Set by withRepos; already bound to the authenticated user. */
  notes: NotesRepo;
  attachments: AttachmentsRepo;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
