import { describe, expect, it } from 'vitest';
import { configuredSocials, offeredProviders } from './auth.js';
import type { Env } from './types.js';

/** Only the fields these functions read; the bindings are irrelevant here. */
function env(vars: Record<string, string | undefined>): Env {
  return { APP_URL: 'https://example.com', ...vars } as unknown as Env;
}

/**
 * Enabling a provider is setting two environment variables, and disabling it is deleting
 * one. The point of the convention is that this file names no providers, so an instance
 * can offer something this repository has never heard of.
 */
describe('configuredSocials', () => {
  it('offers a provider once both halves are present', () => {
    expect(
      configuredSocials(env({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })),
    ).toEqual(['google']);
  });

  it('offers nothing for a half-configured provider', () => {
    expect(configuredSocials(env({ GOOGLE_CLIENT_ID: 'id' }))).toEqual([]);
    expect(configuredSocials(env({ GOOGLE_CLIENT_SECRET: 'secret' }))).toEqual([]);
  });

  /** The case the hard-coded list could not serve: a provider nothing here mentions. */
  it('offers providers this codebase never names', () => {
    const configured = configuredSocials(
      env({
        DISCORD_CLIENT_ID: 'id',
        DISCORD_CLIENT_SECRET: 'secret',
        MICROSOFT_CLIENT_ID: 'id',
        MICROSOFT_CLIENT_SECRET: 'secret',
      }),
    );
    expect(configured).toContain('discord');
    expect(configured).toContain('microsoft');
  });

  /** Deleting one variable is how a provider is retired, as GitHub was on unbent.app. */
  it('drops a provider when a credential is removed', () => {
    const both = { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };
    expect(configuredSocials(env(both))).toEqual(['github']);
    expect(configuredSocials(env({ GITHUB_CLIENT_SECRET: 'secret' }))).toEqual([]);
  });

  it('ignores a name that is not a provider', () => {
    expect(configuredSocials(env({ NOTAPROVIDER_CLIENT_ID: 'a', NOTAPROVIDER_CLIENT_SECRET: 'b' })))
      .toEqual([]);
  });
});

describe('offeredProviders', () => {
  /** Passkeys need nothing registered anywhere, so they are the one opt-out. */
  it('offers passkeys by default', () => {
    expect(offeredProviders(env({}))).toContain('passkey');
  });

  it('withholds passkeys when an instance asks it to', () => {
    expect(offeredProviders(env({ AUTH_PASSKEY: '0' }))).not.toContain('passkey');
  });

  it('offers a password only when the instance turns it on', () => {
    expect(offeredProviders(env({}))).not.toContain('password');
    expect(offeredProviders(env({ AUTH_PASSWORD: '1' }))).toContain('password');
  });

  /**
   * Codes need somewhere to go. A deployed instance without mail must not offer a form
   * whose code is written to a log nobody reads.
   */
  it('offers email codes only where one could arrive', () => {
    expect(offeredProviders(env({}))).not.toContain('email-otp');
    expect(
      offeredProviders(env({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' })),
    ).toContain('email-otp');
  });

  it('offers email codes locally, where the console stands in for a mail provider', () => {
    const local = { APP_URL: 'http://localhost:5173' };
    expect(offeredProviders(env(local))).toContain('email-otp');
  });

  /** An instance with nothing configured still has to answer, and answer honestly. */
  it('reports social providers alongside the local methods', () => {
    const offered = offeredProviders(
      env({ DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 'secret', AUTH_PASSWORD: '1' }),
    );
    expect(offered).toEqual(['discord', 'password', 'passkey']);
  });
});
