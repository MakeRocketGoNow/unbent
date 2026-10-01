import type { NotesRepo } from './lib/notes-repo.js';
import type { AttachmentsRepo } from './lib/attachments-repo.js';
import type { UserStore } from './store/user-store.js';

/** Bindings declared in wrangler.toml, plus secrets supplied via `wrangler secret`. */
export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  /**
   * One SQLite-backed Durable Object per account, holding that account's notes. Reached
   * by user id: `USER_STORE.get(USER_STORE.idFromName(userId))`. A type-only import of the
   * class, so nothing outside src/store/ and the entry point pulls `cloudflare:workers`
   * into its module graph — the unit tests run under Node, where that import has no
   * meaning. See src/store/user-store.ts.
   */
  USER_STORE: DurableObjectNamespace<UserStore>;
  /**
   * Where each account's store is created. Unset — every instance today — lets the
   * runtime place an object near the first request for it. `eu` pins every new store to
   * the EU jurisdiction, for an operator whose users need their notes kept there; it
   * applies to objects created after it is set, and moves none. Read once per request in
   * `reposFor`.
   */
  STORE_JURISDICTION?: string;
  /**
   * `"0"` stops the copy and the sweep writing `account_directory.migrated_at`, which is
   * what freezes an account's rows in the shared D1 tables (migration 0032). Set only on
   * the pull-request previews, which share the dev instance's D1 while dev still runs
   * `main` and writes those rows; anywhere else it is unset and the freeze is on.
   */
  STORE_FREEZE_D1?: string;
  /**
   * `"1"` on a pull-request preview whose note stores are its own rather than the dev
   * instance's: the preview workflow sets it when the PR changes `src/store/`, so the PR's
   * store code is what answers instead of `main`'s. Those stores start empty, and the page
   * offers to fill them with the seed (`AppConfig.ownStores`). Accounts and the files
   * bucket are still the dev instance's, which is why the orphaned-file sweep refuses to
   * run here. Unset everywhere else.
   */
  PREVIEW_OWN_STORES?: string;
  /**
   * Workers AI, for extracting a PDF's text on upload. Bound in production only — see
   * wrangler.toml — so it is optional here, and its absence means the browser does the
   * extracting, as it did before.
   */
  AI?: Ai;
  /**
   * The origin the app is served on — what Better Auth, the passkey relying party, secure
   * cookies, the MCP audience and the legal documents' host all derive from.
   *
   * Always present by the time a route sees it, and optional in the deployment: the
   * Worker's entry point fills it from the request origin when nothing configured one
   * (see lib/app-url.ts), so an instance need not know its own address before its first
   * deploy. Setting it — as a secret, which survives deploys — pins one origin and makes
   * every other hostname the Worker answers on refuse sign-in, which is what a deployment
   * with both a custom domain and a workers.dev name wants.
   */
  APP_URL: string;
  /** `wrangler secret put BETTER_AUTH_SECRET`; in dev it comes from .dev.vars. */
  BETTER_AUTH_SECRET: string;
  /**
   * OAuth credentials follow a convention rather than a list: any of Better Auth's
   * thirty-five providers is enabled by setting `<PROVIDER>_CLIENT_ID` and
   * `<PROVIDER>_CLIENT_SECRET`. The two below are declared because this file reads them by
   * name; the rest are found by `configuredSocials` and need no entry here.
   */
  GOOGLE_CLIENT_ID?: string;
  /** Optional second audience, when the Android app asks for its own client id. */
  GOOGLE_ANDROID_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /**
   * '1' offers email-and-password sign-in, '0' refuses it.
   *
   * Neither is usually needed. Password is offered by default when nothing else on the
   * instance can create an account — no OAuth and no mail — and withdrawn as soon as
   * something can, so a self-hoster gets a way in without asking and unbent.app never sees
   * it. '1' is for wanting a password alongside a configured provider; '0' is for refusing
   * the default, and is the one setting here that can leave nobody a way in.
   */
  AUTH_PASSWORD?: string;
  /**
   * '1' enables password auth so the isolation suite and `pnpm seed:demo` can mint
   * sessions. `pnpm dev` passes it on the command line, so it is on for every local
   * Worker and never in a file a deploy reads.
   */
  ALLOW_TEST_CREDENTIALS?: string;
  /**
   * '0' withholds passkeys, which are otherwise always offered because nothing has to be
   * registered anywhere for them to work. For an operator who would rather not explain
   * them, not because they can fail.
   */
  AUTH_PASSKEY?: string;
  /**
   * Comma-separated emails allowed to create an account. Unset or empty means anyone
   * can sign up, which is fine locally but not for a deployed instance — unless that is
   * what the instance wants, which is what PUBLIC_SIGNUPS is for.
   */
  ALLOWED_EMAILS?: string;
  /**
   * '1' declares that an empty ALLOWED_EMAILS is deliberate, silencing the warning a
   * deployed instance otherwise logs about accepting a sign-up from anyone.
   *
   * It does not open sign-ups; an empty allowlist already has. Nothing reads it but
   * warnIfOpenToAnyone, so setting it alongside an allowlist does nothing at all.
   */
  PUBLIC_SIGNUPS?: string;
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
  /**
   * Who runs this instance: the legal entity the built-in privacy policy and terms name,
   * and the address they tell people to write to.
   *
   * Both or neither, the same shape as an OAuth credential pair — a policy naming a company
   * with no way to reach it is worse than one that admits it does not exist. Unset is the
   * deliberate default for a fresh checkout: this repository is open source, and an
   * instance that has not said who runs it must not publish somebody else's name. See
   * `operatorOf` in lib/instance.ts.
   */
  OPERATOR_NAME?: string;
  OPERATOR_EMAIL?: string;
  /**
   * Comma-separated emails of the accounts that run this instance, the shape of
   * `ALLOWED_EMAILS`. Distinct from the pair above, which name one legal contact for the
   * documents: this is who, when signed in, is shown an operator-only fault they can fix —
   * currently a title model that rejected its `ANTHROPIC_API_KEY`. Unset — every fresh
   * checkout — means nobody is flagged and nothing operator-only is ever surfaced. See
   * `isOperator` in lib/instance.ts.
   */
  OPERATOR_EMAILS?: string;
  /**
   * Legal documents hosted somewhere other than this app, for an operator whose lawyers
   * wrote their own.
   *
   * Both or neither again, and when both are set they win over the built-in documents: an
   * operator who has published their own is the one who should be believed. The built-in
   * pages then say so and link onward rather than 404ing, because the Play listing points
   * at one of them.
   */
  LEGAL_PRIVACY_URL?: string;
  LEGAL_TERMS_URL?: string;
  /**
   * The Digital Asset Links document this origin serves at /.well-known/assetlinks.json:
   * which Android apps, by package and signing certificate, it vouches for. Verbatim JSON.
   *
   * Per deployment because it names an app. Unset — every fresh instance — means the origin
   * vouches for none, which is right until an operator has an app of their own; see
   * routes/well-known.ts and the README's Android section.
   */
  ANDROID_ASSET_LINKS?: string;
  /**
   * PostHog, for grouping the browser errors that `/api/client-errors` only ever logs.
   *
   * Setting the key is what turns it on: the SPA loads the SDK only when the config says
   * so, and `/ingest/*` refuses to proxy anything without it. Unset — the default, and what
   * every self-hosted instance gets — means no SDK, no third party, and a privacy policy
   * that does not mention one.
   *
   * The token is public and write-only, so it could sit in this file; it is a secret on the
   * hosted instance only to keep one fewer credential in a repository people will fork.
   */
  POSTHOG_KEY?: string;
  /**
   * Where the Worker forwards that traffic. Defaults to PostHog's US cloud; set it for the
   * EU cloud or a self-hosted PostHog. The browser never sees it — it talks to `/ingest` on
   * this origin, which is what keeps content blockers from dropping the reports.
   */
  POSTHOG_HOST?: string;
  /**
   * The preview sign-in relay, which lets a per-PR preview borrow a Google session from the
   * standing dev instance without registering an OAuth callback for a hostname that changes
   * every PR. Two origins, one on each side of the handoff; see lib/preview-relay.ts.
   *
   * `PREVIEW_RELAY_ORIGIN` is set on a *preview* and names the dev instance it bounces to,
   * e.g. https://dev.unbent.app. Its presence is what draws the relay button on that
   * preview's login screen.
   *
   * `PREVIEW_RELAY_SUBDOMAIN` is set on the *dev instance* and names the account's
   * workers.dev subdomain, e.g. of2668. It is the allowlist `/api/preview-relay/start`
   * checks a return origin against before handing it a one-time token — a security
   * boundary, so it is configured rather than inferred: anyone can own a `*.workers.dev`
   * account, and only configuration knows which subdomain is ours.
   */
  PREVIEW_RELAY_ORIGIN?: string;
  PREVIEW_RELAY_SUBDOMAIN?: string;
  /**
   * A TypeSafe API key, which turns on auto-fill: the control on a note that files it —
   * title, notebook, tags and fields — from what it and its scans say. Read by lib/jev.ts;
   * lib/autofill.ts says exactly what is sent. Unset, the editor draws no control and the
   * route answers 503. `wrangler secret put TYPESAFE_API_KEY`, or .dev.vars locally.
   */
  TYPESAFE_API_KEY?: string;
  /**
   * Where those requests go instead of TypeSafe's endpoint. For a stand-in during
   * development — the kind of server a test runs to answer with canned judgements — and
   * nothing else; a deployed instance leaves it unset.
   */
  TYPESAFE_API_URL?: string;
  /**
   * An Anthropic API key, which turns on the language model: reading images and text-less
   * scans — what a file shows, and any text on it, recorded as the file's text for search
   * and auto-fill — and writing auto-fill's titles. Read by lib/llm.ts. Unset, pictures
   * have no text and titles are Jev's pick of a line, as before.
   * `wrangler secret put ANTHROPIC_API_KEY`, or .dev.vars locally.
   */
  ANTHROPIC_API_KEY?: string;
  /** Where those requests go instead of Anthropic's endpoint; a stand-in for development. */
  ANTHROPIC_API_URL?: string;
  /**
   * The model the language model client asks for, e.g. `claude-sonnet-5` to trade some
   * reading accuracy for cost. Unset means `LLM_MODEL_DEFAULT` in lib/llm.ts.
   */
  ANTHROPIC_MODEL?: string;
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
  /** Set by sessionMiddleware when the session could not be looked up at all. */
  sessionUnavailable?: boolean;
  /** Set by withRepos; already bound to the authenticated user. */
  notes: NotesRepo;
  attachments: AttachmentsRepo;
}

export type AppEnv = { Bindings: Env; Variables: Variables };

/**
 * What the platform actually hands the Worker: `Env` before the entry point has settled
 * `APP_URL`. Only lib/app-url.ts should need this name.
 */
export type RawEnv = Omit<Env, 'APP_URL'> & { APP_URL?: string };
