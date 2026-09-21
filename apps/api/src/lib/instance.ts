import type { AppConfig } from '@unbent/shared';
import type { Env } from '../types.js';

/**
 * What this instance says about itself, beyond how to sign in to it.
 *
 * Separate from `auth.ts`, which answers the same shape of question — "what does this
 * deployment offer?" — but only ever about sign-in. These are about the operator: who they
 * are, and where their legal documents live.
 *
 * Every function here returns `undefined` rather than a default. That is the whole point:
 * the repository is open source, so a value nobody configured has no honest fallback, and
 * inventing one publishes a claim the operator never made. `/api/config` drops undefined
 * fields on the way out, which the client reads as "not offered" — the same convention
 * `accountDeletion` already uses.
 */

/**
 * Both halves or nothing, the convention `configuredSocials` established for OAuth.
 *
 * A policy that names a company but gives no way to reach it is worse than one that admits
 * there is no policy here, so a half-configured operator is treated as none at all.
 */
export function operatorOf(env: Env): AppConfig['operator'] | undefined {
  const name = env.OPERATOR_NAME?.trim();
  const email = env.OPERATOR_EMAIL?.trim();
  if (!name || !email) return undefined;
  // From APP_URL rather than the request: the documents should give the address the
  // operator configured, not whichever host a WebView or Tailscale name arrived on.
  return { name, email, host: new URL(env.APP_URL).host };
}

/**
 * The accounts that run this instance, by email, the shape `ALLOWED_EMAILS` uses.
 *
 * Separate from `OPERATOR_NAME`/`OPERATOR_EMAIL`, which name the legal entity for the
 * documents and are a single contact, not a sign-in identity. This is a set of the people
 * whose session may be shown an operator-only fault to fix — right now, a title model that
 * rejected its key. Unset — every fresh checkout, and every fork — means nobody is an
 * operator here and no such fault is ever surfaced, which is the safe default for a
 * repository people deploy unchanged.
 */
export function operatorEmails(env: Env): Set<string> {
  return new Set(
    (env.OPERATOR_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether this signed-in email runs the instance. False for an absent email or an empty list. */
export function isOperator(env: Env, email: string | undefined): boolean {
  if (!email) return false;
  return operatorEmails(env).has(email.trim().toLowerCase());
}

/**
 * Where this instance's privacy policy and terms are, if it has any.
 *
 * Three answers, in order of who should be believed. An operator who has published their
 * own documents elsewhere wins, even over a configured operator name — they went to the
 * trouble, so the links point there. Failing that, an instance that knows who runs it can
 * render the built-in documents, which are written to be filled in. Failing both, there is
 * nothing to link to, and saying so is better than linking to a page that has nothing on
 * it.
 *
 * A half-set pair of URLs is ignored rather than half-applied: linking Terms to somebody's
 * own page while Privacy silently falls back to a built-in document nobody wrote is the
 * kind of mismatch a reader would never notice and an operator would never intend.
 */
export function legalLinksOf(env: Env): AppConfig['legal'] | undefined {
  const privacy = env.LEGAL_PRIVACY_URL?.trim();
  const terms = env.LEGAL_TERMS_URL?.trim();
  if (privacy && terms) return { privacy, terms };
  if (operatorOf(env)) return { privacy: '/privacy', terms: '/terms' };
  return undefined;
}

/** PostHog's US cloud, which is where a project lives unless its owner chose otherwise. */
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/** Where the Worker forwards `/ingest/*`. No trailing slash, so paths can be appended. */
export function posthogHost(env: Env): string {
  return (env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/$/, '');
}

/**
 * Where the SDK's own static files come from.
 *
 * PostHog serves its bundle from a separate host to the one that takes events —
 * `us-assets.i.` beside `us.i.` — and the proxy has to send `/static/*` to the right one or
 * the browser gets an event endpoint's answer where it expected JavaScript. A self-hosted
 * PostHog serves both from one origin, which is what the unchanged fallback means.
 */
export function posthogAssetsHost(env: Env): string {
  return posthogHost(env).replace(
    /^(https:\/\/[a-z0-9-]+)\.i\.posthog\.com$/i,
    '$1-assets.i.posthog.com',
  );
}

/**
 * The error-tracking service this instance reports to, if it has one.
 *
 * The key alone turns it on; the host has a sensible default, and an instance setting one
 * without the other means the US cloud rather than nothing.
 *
 * `uiHost` is derived rather than configured because it is the same deployment seen from a
 * different side: `us.i.posthog.com` takes the events, `us.posthog.com` is the app someone
 * opens to read them. The SDK needs both, and asking an operator to set two variables that
 * differ by three characters is a way to get one of them wrong. A self-hosted PostHog
 * serves both from one origin, and the unchanged fallback is right for it.
 */
export function posthogOf(env: Env): AppConfig['posthog'] | undefined {
  const key = env.POSTHOG_KEY?.trim();
  if (!key) return undefined;
  const uiHost = posthogHost(env).replace(
    /^(https:\/\/[a-z0-9-]+)\.i\.posthog\.com$/i,
    '$1.posthog.com',
  );
  return { key, uiHost };
}
