import { describe, expect, it } from 'vitest';
import {
  legalLinksOf,
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

describe('legalLinksOf', () => {
  const EXTERNAL = {
    LEGAL_PRIVACY_URL: 'https://example.com/privacy',
    LEGAL_TERMS_URL: 'https://example.com/terms',
  };

  it('points at the built-in documents when an operator is named', () => {
    expect(legalLinksOf(env(OPERATOR))).toEqual({ privacy: '/privacy', terms: '/terms' });
  });

  /** Someone who published their own documents went to the trouble; believe them. */
  it('prefers documents hosted elsewhere, even over a named operator', () => {
    expect(legalLinksOf(env({ ...OPERATOR, ...EXTERNAL }))).toEqual({
      privacy: 'https://example.com/privacy',
      terms: 'https://example.com/terms',
    });
  });

  /*
   * Half-applied would mean Terms linking to the operator's own page while Privacy quietly
   * fell back to a document nobody wrote — a mismatch no reader would notice and no
   * operator would intend.
   */
  it('ignores half a pair of external URLs', () => {
    const half = { ...OPERATOR, LEGAL_PRIVACY_URL: 'https://example.com/privacy' };
    expect(legalLinksOf(env(half))).toEqual({ privacy: '/privacy', terms: '/terms' });
    expect(legalLinksOf(env({ LEGAL_TERMS_URL: 'https://example.com/terms' }))).toBeUndefined();
  });

  it('has nothing to link to when the instance publishes neither', () => {
    expect(legalLinksOf(env({}))).toBeUndefined();
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
