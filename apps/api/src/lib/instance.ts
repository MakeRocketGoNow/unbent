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
