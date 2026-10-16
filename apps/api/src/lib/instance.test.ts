import { describe, expect, it } from 'vitest';
import { LEGAL_CHANGE, LEGAL_VERSION } from '@unbent/shared';
import {
  frontPageOf,
  isOperator,
  legalLinksOf,
  legalVersionOf,
  operatorEmails,
  operatorOf,
  posthogAssetsHost,
  posthogHost,
  posthogOf,
} from './instance.js';
import type { Env } from '../types.js';

/** Only the fields these functions read; the bindings are irrelevant here. */
function env(vars: Record<string, string | undefined>): Env {
  return { APP_URL: 'https://example.com', ...vars } as unknown as Env;
}

const OPERATOR = { OPERATOR_NAME: 'Example Co', OPERATOR_EMAIL: 'help@example.com' };

/**
 * The rule these pin is that nothing is inferred. An instance that has not been told who
 * runs it says so, rather than falling back to whoever wrote the code — which is what the
 * constants in the legal documents used to do to every fork.
 */
describe('operatorOf', () => {
  it('names the operator once both halves are set', () => {
    expect(operatorOf(env(OPERATOR))).toEqual({
      name: 'Example Co',
      email: 'help@example.com',
      host: 'example.com',
    });
  });

  it('treats half an operator as none, the way a credential pair works', () => {
    expect(operatorOf(env({ OPERATOR_NAME: 'Example Co' }))).toBeUndefined();
    expect(operatorOf(env({ OPERATOR_EMAIL: 'help@example.com' }))).toBeUndefined();
  });

  it('is nobody by default, which is what an unconfigured fork must be', () => {
    expect(operatorOf(env({}))).toBeUndefined();
  });

  /** The address the operator configured, port and all — not whatever host asked. */
  it('takes the host from APP_URL', () => {
    const at = env({ ...OPERATOR, APP_URL: 'https://notes.example.org:8443' });
    expect(operatorOf(at)?.host).toBe('notes.example.org:8443');
  });
});

/**
 * Who runs the instance, for the one thing only they should be shown — a title model that
 * rejected its key. The same "nobody by default" rule as the rest of this file: an
 * unconfigured fork flags no one, so its notes read the same for everyone.
 */
describe('operatorEmails and isOperator', () => {
  it('is nobody by default', () => {
    expect(operatorEmails(env({})).size).toBe(0);
    expect(isOperator(env({}), 'anyone@example.com')).toBe(false);
  });

  it('reads a comma list, trimmed and case-folded, the way ALLOWED_EMAILS does', () => {
    const two = env({ OPERATOR_EMAILS: ' Me@Example.com , you@example.com ' });
    expect(operatorEmails(two)).toEqual(new Set(['me@example.com', 'you@example.com']));
    expect(isOperator(two, 'ME@EXAMPLE.COM')).toBe(true);
    expect(isOperator(two, 'you@example.com')).toBe(true);
    expect(isOperator(two, 'stranger@example.com')).toBe(false);
  });

  it('is never an operator without an email to check', () => {
    const one = env({ OPERATOR_EMAILS: 'me@example.com' });
    expect(isOperator(one, undefined)).toBe(false);
    expect(isOperator(one, '')).toBe(false);
  });
});

/** The five settings that turn billing on (`billingOn`). */
const PADDLE = {
  PADDLE_API_KEY: 'pdl_sdbx_x',
  PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_x',
  PADDLE_CLIENT_TOKEN: 'test_x',
  PADDLE_PLAN_PRICE_ID: 'pri_plan',
  PADDLE_STORAGE_PRICE_ID: 'pri_storage',
};

/**
 * The version an instance that sells nothing is on: the one before a billing-only change,
 * since for it the documents did not change, else the current one (`legalVersionOf`).
 */
const PLAIN_VERSION = LEGAL_CHANGE?.billingOnly ? LEGAL_CHANGE.since : LEGAL_VERSION;

describe('legalLinksOf', () => {
  const EXTERNAL = {
    LEGAL_PRIVACY_URL: 'https://example.com/privacy',
    LEGAL_TERMS_URL: 'https://example.com/terms',
  };

  it('points at the built-in documents when an operator is named', () => {
    expect(legalLinksOf(env(OPERATOR))).toEqual({ privacy: '/privacy', terms: '/terms', version: PLAIN_VERSION });
  });

  /** Someone who published their own documents went to the trouble; believe them. */
  it('prefers documents hosted elsewhere, even over a named operator', () => {
    expect(legalLinksOf(env({ ...OPERATOR, ...EXTERNAL }))).toEqual({
      privacy: 'https://example.com/privacy',
      terms: 'https://example.com/terms',
      version: '1',
    });
  });

  /*
   * Half-applied would mean Terms linking to the operator's own page while Privacy quietly
   * fell back to a document nobody wrote — a mismatch no reader would notice and no
   * operator would intend.
   */
  it('ignores half a pair of external URLs', () => {
    const half = { ...OPERATOR, LEGAL_PRIVACY_URL: 'https://example.com/privacy' };
    expect(legalLinksOf(env(half))).toEqual({ privacy: '/privacy', terms: '/terms', version: PLAIN_VERSION });
    expect(legalLinksOf(env({ LEGAL_TERMS_URL: 'https://example.com/terms' }))).toBeUndefined();
  });

  it('has nothing to link to when the instance publishes neither', () => {
    expect(legalLinksOf(env({}))).toBeUndefined();
  });

  /*
   * The web app draws the payment terms on this word alone, rather than reading `billing`
   * and `frontPage` for itself, so the field is the one place the rule is answered. Only
   * on the built-in documents: an operator's own say what they say.
   */
  it('says the built-in documents cover a sale exactly where the instance makes one', () => {
    expect(legalLinksOf(env(OPERATOR))?.sellsPlan).toBeUndefined();
    expect(legalLinksOf(env({ ...OPERATOR, FRONT_PAGE: '1' }))?.sellsPlan).toBe(true);
    expect(legalLinksOf(env({ ...OPERATOR, ...PADDLE }))?.sellsPlan).toBe(true);
    expect(legalLinksOf(env({ ...OPERATOR, ...EXTERNAL, FRONT_PAGE: '1' }))?.sellsPlan).toBeUndefined();
  });
});

/**
 * Which version everyone must have agreed to (MAK-209). The built-in documents' version
 * unless an operator who publishes their own says otherwise, since only they know when
 * those change.
 */
describe('legalVersionOf', () => {
  it('asks for the built-in version, whatever the environment says', () => {
    expect(legalVersionOf(env({}), 'built-in').version).toBe(PLAIN_VERSION);
    expect(legalVersionOf(env({ LEGAL_VERSION: '2027-01-01' }), 'built-in').version).toBe(PLAIN_VERSION);
  });

  /*
   * A change only to the payment terms is no change where there is no sale: those sections
   * are not in that instance's terms (MAK-108), so it stays on the version before and its
   * accounts are not asked again. Where there is one, the version moves and the sentence
   * says what is new.
   */
  it('moves the version for a billing-only change only where billing is on', () => {
    expect(LEGAL_CHANGE?.billingOnly).toBe(true);
    if (!LEGAL_CHANGE?.billingOnly) return;
    expect(LEGAL_CHANGE.since < LEGAL_VERSION).toBe(true);
    expect(legalVersionOf(env(PADDLE), 'built-in')).toEqual({ version: LEGAL_VERSION, change: LEGAL_CHANGE.text });
    expect(legalVersionOf(env({}), 'built-in')).toEqual({ version: LEGAL_CHANGE.since });
  });

  /* The front page states a price, so its instance publishes the payment terms before
     Paddle has issued the keys that turn billing on — which its review requires. */
  it('says it where the front page is on, with or without billing', () => {
    expect(legalVersionOf(env({ FRONT_PAGE: '1' }), 'built-in').change).toBe(LEGAL_CHANGE?.text);
  });

  it('asks for the operator’s own version for their own documents', () => {
    expect(legalVersionOf(env({ LEGAL_VERSION: ' 2027-01-01 ' }), 'own')).toEqual({ version: '2027-01-01' });
  });

  /*
   * Never the repository's: a fork with its own documents would otherwise be asked again
   * every time the built-in ones changed, under a sentence about documents it does not
   * publish.
   */
  it('gives an operator’s own documents a fixed version of their own when unset', () => {
    expect(legalVersionOf(env({}), 'own')).toEqual({ version: '1' });
    expect(legalVersionOf(env({ LEGAL_VERSION: '  ' }), 'own')).toEqual({ version: '1' });
  });
});

/**
 * Error tracking is off unless an instance has a key, which is what makes it something a
 * fork opts into rather than inherits. The two host derivations exist so that an operator
 * sets one variable instead of three that differ by a few characters each.
 */
describe('posthogOf', () => {
  it('is off without a key, which is what a self-hosted instance gets', () => {
    expect(posthogOf(env({}))).toBeUndefined();
    expect(posthogOf(env({ POSTHOG_HOST: 'https://eu.i.posthog.com' }))).toBeUndefined();
  });

  it('defaults to the US cloud, and derives the app host from the ingest host', () => {
    expect(posthogOf(env({ POSTHOG_KEY: 'phc_x' }))).toEqual({
      key: 'phc_x',
      uiHost: 'https://us.posthog.com',
    });
  });

  it('follows the key to another region', () => {
    const eu = env({ POSTHOG_KEY: 'phc_x', POSTHOG_HOST: 'https://eu.i.posthog.com' });
    expect(posthogOf(eu)?.uiHost).toBe('https://eu.posthog.com');
  });

  /* A self-hosted PostHog serves the app and the ingest endpoint from one origin. */
  it('leaves a self-hosted host alone, trailing slash and all', () => {
    const own = env({ POSTHOG_KEY: 'phc_x', POSTHOG_HOST: 'https://posthog.example.com/' });
    expect(posthogOf(own)?.uiHost).toBe('https://posthog.example.com');
  });
});

describe('posthogHost and posthogAssetsHost', () => {
  it('sends events and static files to the hosts that serve them', () => {
    expect(posthogHost(env({}))).toBe('https://us.i.posthog.com');
    expect(posthogAssetsHost(env({}))).toBe('https://us-assets.i.posthog.com');
  });

  it('keeps the pair together in another region', () => {
    const eu = env({ POSTHOG_HOST: 'https://eu.i.posthog.com' });
    expect(posthogHost(eu)).toBe('https://eu.i.posthog.com');
    expect(posthogAssetsHost(eu)).toBe('https://eu-assets.i.posthog.com');
  });

  it('serves both from one origin when PostHog is self-hosted', () => {
    const own = env({ POSTHOG_HOST: 'https://posthog.example.com' });
    expect(posthogAssetsHost(own)).toBe('https://posthog.example.com');
  });
});

/**
 * The front page states unbent.app's prices, so the case that matters is the fork that
 * set nothing — and the one that set something other than the documented value, which
 * must not publish an offer by accident either.
 */
describe('frontPageOf', () => {
  it('is off unless the instance says it is the public one', () => {
    expect(frontPageOf({})).toBeUndefined();
    expect(frontPageOf({ FRONT_PAGE: '0' })).toBeUndefined();
    expect(frontPageOf({ FRONT_PAGE: 'true' })).toBeUndefined();
    expect(frontPageOf({ FRONT_PAGE: '' })).toBeUndefined();
  });

  it('is on for exactly 1', () => {
    expect(frontPageOf({ FRONT_PAGE: '1' })).toBe(true);
    expect(frontPageOf({ FRONT_PAGE: ' 1 ' })).toBe(true);
  });
});
