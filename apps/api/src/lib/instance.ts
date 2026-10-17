import { legalVersionFor, type AppConfig } from '@unbent/shared';
import { canAutofill } from './jev.js';
import { canUseLlm } from './llm.js';
import type { Env } from '../types.js';
import { billingOn, type PaddleEnv } from './paddle.js';

/**
 * What this instance says about itself, beyond how to sign in to it.
 *
 * Separate from `auth.ts`, which answers the same shape of question ("what does this
 * deployment offer?") but only ever about sign-in. These are about the operator: who they
 * are, and where their legal documents live.
 *
 * Every function here returns `undefined` rather than a default. That is the whole point:
 * the repository is public, so a value nobody configured has no honest fallback, and
 * inventing one publishes a claim the operator never made. `/api/config` drops undefined
 * fields on the way out, which the client reads as "not offered", the same convention
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
 * whose session may be shown an operator-only fault to fix: right now, a title model that
 * rejected its key. Unset (every fresh checkout, and every fork) means nobody is an
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
 * own documents elsewhere wins, even over a configured operator name: they went to the
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
  if (privacy && terms) return { privacy, terms, ...legalVersionOf(env, 'own') };
  if (operatorOf(env)) {
    return {
      privacy: '/privacy',
      terms: '/terms',
      ...legalVersionOf(env, 'built-in'),
      ...(sellsPlanOf(env) ? { sellsPlan: true } : {}),
    };
  }
  return undefined;
}

/**
 * Whether this instance sells a plan, which is what decides whether the built-in terms
 * carry the sections on payment, renewal and refunds, and the policy names Paddle.
 *
 * Billing on, or a front page stating the price. The front page counts on its own because
 * a price on offer is a sale the terms have to cover whether or not checkout works yet, and
 * because Paddle's website review reads the terms for a refund policy before it issues the
 * live keys that turn billing on. Billing alone left unbent.app unable to pass the review
 * that billing waits on.
 *
 * Said here once and sent in `/api/config` (`legal.sellsPlan`), so the web app reads the
 * answer rather than working it out again from `billing` and `frontPage`: the sentence on
 * what changed and the documents it describes must agree, and two copies of the rule would
 * part the first time one of them learned a new case. `undefined` rather than `false` when
 * off, so the field is dropped and an older instance reads the same as one that sells none.
 */
export function sellsPlanOf(env: Pick<Env, 'FRONT_PAGE'> & PaddleEnv): true | undefined {
  return billingOn(env) || frontPageOf(env) || undefined;
}

/**
 * The version an operator's own documents stand at until the operator says otherwise.
 *
 * Fixed, and never the built-in `LEGAL_VERSION`: that one moves with this repository, and
 * borrowing it would ask every account on a fork to agree again each time the documents
 * here changed (documents that fork does not publish) under a sentence describing them.
 */
const OWN_DOCUMENTS_VERSION = '1';

/**
 * Which version of the documents a signed-in account must have agreed to, and what is new
 * in it. See `LEGAL_CHANGES`.
 *
 * For the built-in documents, the newest change whose text this instance publishes
 * (`legalVersionFor`): the terms of sale only where it sells a plan (`sellsPlanOf`), and
 * what Auto-fill sends only where it has the key for it (`canAutofill`, the rule
 * `/api/config`'s `autofill` reports and the policy is drawn from). An instance that
 * publishes neither stays on the first version, and nobody there is asked again for text
 * that reads word for word as it did. One that starts selling later, or turns Auto-fill
 * on, moves then and its accounts are asked once, with the sentence; one that stops moves
 * back, and `coversLegalVersion` keeps the accounts that agreed to the later version from
 * being asked for the earlier one.
 *
 * For an operator's own, `LEGAL_VERSION` from the environment: this repository cannot
 * know when those change, so the operator moves it, and everyone is asked again. Unset,
 * everyone is asked once. No sentence on what changed: the built-in ones describe other
 * documents, and an operator who wants one can say it in their own.
 */
export function legalVersionOf(
  env: Pick<Env, 'LEGAL_VERSION' | 'FRONT_PAGE' | 'TYPESAFE_API_KEY'> & PaddleEnv,
  documents: 'built-in' | 'own',
): { version: string; change?: string } {
  if (documents === 'own') return { version: env.LEGAL_VERSION?.trim() || OWN_DOCUMENTS_VERSION };
  return legalVersionFor({ sellsPlan: Boolean(sellsPlanOf(env)), autofill: canAutofill(env) });
}

/**
 * Whether `/` shows the front page to someone signed out, rather than the sign-in screen.
 *
 * Exactly `'1'`, the convention `PUBLIC_SIGNUPS` uses, so a stray value does not publish
 * a price list. `undefined` rather than `false` when off, so `/api/config` drops the field
 * and an instance older than it reads the same as one that never set it.
 */
export function frontPageOf(env: Pick<Env, 'FRONT_PAGE'>): true | undefined {
  return env.FRONT_PAGE?.trim() === '1' || undefined;
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
 * PostHog serves its bundle from a separate host to the one that takes events
 * (`us-assets.i.` beside `us.i.`), and the proxy has to send `/static/*` to the right one or
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
 * Whether an Auto-fill press here also calls the language model (`AppConfig.llm`): only
 * where Auto-fill is on at all, which the Jev key alone decides, and an Anthropic key is
 * set. It is what decides whether the privacy policy names Anthropic (MAK-230), so an
 * Anthropic key on an instance with no Jev key, which no press can reach, names nobody.
 */
export function llmOf(env: Env): true | undefined {
  return canAutofill(env) && canUseLlm(env) ? true : undefined;
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
