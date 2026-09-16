import { describe, expect, it } from 'vitest';
import { isTrustedPreviewOrigin, previewRelayOrigin } from './preview-relay.js';
import type { Env } from '../types.js';

/** Only the fields these functions read; the bindings are irrelevant here. */
function env(vars: Record<string, string | undefined>): Env {
  return { APP_URL: 'https://dev.unbent.app', ...vars } as unknown as Env;
}

const SUBDOMAIN = 'of2668';

describe('previewRelayOrigin', () => {
  it('normalises a configured origin to a bare origin', () => {
    expect(previewRelayOrigin(env({ PREVIEW_RELAY_ORIGIN: 'https://dev.unbent.app' }))).toBe(
      'https://dev.unbent.app',
    );
  });

  it('strips a path and trailing slash', () => {
    expect(
      previewRelayOrigin(env({ PREVIEW_RELAY_ORIGIN: 'https://dev.unbent.app/some/path' })),
    ).toBe('https://dev.unbent.app');
  });

  it('is undefined when unset or blank', () => {
    expect(previewRelayOrigin(env({}))).toBeUndefined();
    expect(previewRelayOrigin(env({ PREVIEW_RELAY_ORIGIN: '   ' }))).toBeUndefined();
  });

  it('treats a value that is not a URL as none rather than throwing', () => {
    expect(previewRelayOrigin(env({ PREVIEW_RELAY_ORIGIN: 'not a url' }))).toBeUndefined();
  });
});

describe('isTrustedPreviewOrigin', () => {
  const withSub = (vars: Record<string, string | undefined> = {}) =>
    env({ PREVIEW_RELAY_SUBDOMAIN: SUBDOMAIN, ...vars });

  it('accepts a real preview host on our subdomain', () => {
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-120.${SUBDOMAIN}.workers.dev`),
    ).toBe(true);
  });

  it('accepts any PR number', () => {
    for (const n of ['1', '7', '120', '99999']) {
      expect(
        isTrustedPreviewOrigin(withSub(), `https://unbent-pr-${n}.${SUBDOMAIN}.workers.dev`),
      ).toBe(true);
    }
  });

  it('refuses everything when no subdomain is configured', () => {
    // Even a URL that would otherwise match: without the configured subdomain there is no
    // "ours" to compare against, so the dev instance relays to nothing.
    expect(
      isTrustedPreviewOrigin(env({}), `https://unbent-pr-1.${SUBDOMAIN}.workers.dev`),
    ).toBe(false);
  });

  it('refuses a workers.dev host on a different subdomain', () => {
    // The heart of it: anyone can register their own workers.dev account. "Ends in
    // workers.dev" is not enough — it has to be our subdomain.
    expect(
      isTrustedPreviewOrigin(withSub(), 'https://unbent-pr-1.attacker.workers.dev'),
    ).toBe(false);
  });

  it('refuses a prefix attack on the PR label', () => {
    // `unbent-pr-1` is a prefix of `unbent-pr-1-evil`; an exact-match anchor is what stops
    // it. This is the same lesson connect.tsx's ALLOWED_REDIRECTS is built around.
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-1-evil.${SUBDOMAIN}.workers.dev`),
    ).toBe(false);
  });

  it('refuses a non-numeric PR label', () => {
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-.${SUBDOMAIN}.workers.dev`),
    ).toBe(false);
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-1a.${SUBDOMAIN}.workers.dev`),
    ).toBe(false);
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-x.${SUBDOMAIN}.workers.dev`),
    ).toBe(false);
  });

  it('refuses an extra label smuggled in front of our subdomain', () => {
    expect(
      isTrustedPreviewOrigin(
        withSub(),
        `https://unbent-pr-1.evil.${SUBDOMAIN}.workers.dev`,
      ),
    ).toBe(false);
    expect(
      isTrustedPreviewOrigin(
        withSub(),
        `https://unbent-pr-1.${SUBDOMAIN}.workers.dev.evil.com`,
      ),
    ).toBe(false);
  });

  it('refuses the subdomain dot being a wildcard match', () => {
    // The dot in the configured subdomain is escaped, so it cannot match an arbitrary
    // character. `ofX2668` must not pass for subdomain `of.668` were one ever configured;
    // more practically, this pins that escapeRegExp is doing its job.
    expect(
      isTrustedPreviewOrigin(
        env({ PREVIEW_RELAY_SUBDOMAIN: 'of.668' }),
        'https://unbent-pr-1.ofX668.workers.dev',
      ),
    ).toBe(false);
  });

  it('accepts a mixed-case configured subdomain', () => {
    // `URL.hostname` is always lowercased by the parser, so a subdomain configured with any
    // capitalization must still match — otherwise a typo like `Of2668` would silently reject
    // every legitimate preview.
    expect(
      isTrustedPreviewOrigin(
        env({ PREVIEW_RELAY_SUBDOMAIN: 'Of2668' }),
        'https://unbent-pr-1.of2668.workers.dev',
      ),
    ).toBe(true);
  });

  it('refuses http', () => {
    expect(
      isTrustedPreviewOrigin(withSub(), `http://unbent-pr-1.${SUBDOMAIN}.workers.dev`),
    ).toBe(false);
  });

  it('refuses userinfo dressed up to look like our host', () => {
    // `https://unbent-pr-1.of2668.workers.dev@evil.example/` has hostname evil.example.
    expect(
      isTrustedPreviewOrigin(
        withSub(),
        `https://unbent-pr-1.${SUBDOMAIN}.workers.dev@evil.example/`,
      ),
    ).toBe(false);
  });

  it('refuses a non-default port', () => {
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-1.${SUBDOMAIN}.workers.dev:8443`),
    ).toBe(false);
  });

  it('refuses a path, query or fragment', () => {
    expect(
      isTrustedPreviewOrigin(
        withSub(),
        `https://unbent-pr-1.${SUBDOMAIN}.workers.dev/preview-signin`,
      ),
    ).toBe(false);
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-1.${SUBDOMAIN}.workers.dev/?x=1`),
    ).toBe(false);
    expect(
      isTrustedPreviewOrigin(withSub(), `https://unbent-pr-1.${SUBDOMAIN}.workers.dev/#x`),
    ).toBe(false);
  });

  it('refuses the dev instance origin itself', () => {
    // A relay to itself is not a preview sign-in; the two are kept apart on purpose.
    expect(isTrustedPreviewOrigin(withSub(), 'https://dev.unbent.app')).toBe(false);
  });

  it('refuses a value that is not a URL', () => {
    expect(isTrustedPreviewOrigin(withSub(), 'not a url')).toBe(false);
    expect(isTrustedPreviewOrigin(withSub(), '')).toBe(false);
  });
});
