import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountDeletionOffered,
  configuredSocials,
  offeredProviders,
  providerOrigins,
  confirmDeletionUrl,
  warnIfOpenToAnyone,
} from './auth.js';
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

  /**
   * The dead end this closes: a passkey is added from an account you already have and a
   * code needs a mail provider, so an instance with neither used to advertise one button
   * that nobody without an account could use — including whoever had just deployed it.
   */
  it('offers a password when nothing else can create an account', () => {
    expect(offeredProviders(env({}))).toContain('password');
  });

  it('stands aside once a social provider can create one', () => {
    const offered = offeredProviders(
      env({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }),
    );
    expect(offered).toContain('github');
    expect(offered).not.toContain('password');
  });

  it('stands aside once a code could arrive', () => {
    expect(
      offeredProviders(env({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' })),
    ).not.toContain('password');
  });

  it('offers a password whenever the instance asks for one', () => {
    const offered = offeredProviders(
      env({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', AUTH_PASSWORD: '1' }),
    );
    expect(offered).toContain('password');
  });

  /**
   * The one way to refuse the floor, for an instance that wants passkeys and nothing else.
   * It is the setting that can still leave nobody a way in, which is why it has to be
   * asked for explicitly rather than arrived at.
   */
  it('withholds a password when the instance refuses it outright', () => {
    expect(offeredProviders(env({ AUTH_PASSWORD: '0' }))).not.toContain('password');
  });

  /** An explicit no beats the suite's own switch, so the refusal means what it says. */
  it('lets an explicit refusal outrank the test switch', () => {
    expect(
      offeredProviders(env({ AUTH_PASSWORD: '0', ALLOW_TEST_CREDENTIALS: '1' })),
    ).not.toContain('password');
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

/**
 * An open sign-up is a decision, not an accident, and the warning is the only thing that
 * makes it a visible one. Both halves of the condition are pinned: too eager and every
 * local run is noise nobody reads, too shy and a public instance says nothing at all.
 */
describe('providerOrigins', () => {
  it("trusts Apple's origin only while Apple is configured", () => {
    expect(providerOrigins(env({}))).toEqual([]);
    expect(providerOrigins(env({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }))).toEqual([]);
    // Half a pair is not a configured provider, so it opens nothing either.
    expect(providerOrigins(env({ APPLE_CLIENT_ID: 'id' }))).toEqual([]);
    expect(providerOrigins(env({ APPLE_CLIENT_ID: 'id', APPLE_CLIENT_SECRET: 'jwt' }))).toEqual([
      'https://appleid.apple.com',
    ]);
  });
});

describe('warnIfOpenToAnyone', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it('warns when a deployed instance has no allowlist', () => {
    warnIfOpenToAnyone(env({}));
    expect(warn).toHaveBeenCalledOnce();
  });

  /** Naming them is the actionable part: it says what a stranger could actually use. */
  it('names the methods a stranger could sign up with', () => {
    warnIfOpenToAnyone(env({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }));
    expect(warn.mock.calls[0]?.[0]).toContain('github');
  });

  it('stays quiet once an allowlist says who may join', () => {
    warnIfOpenToAnyone(env({ ALLOWED_EMAILS: 'you@example.com' }));
    expect(warn).not.toHaveBeenCalled();
  });

  /** Local development is unrestricted on purpose, and the suite signs up throwaway actors. */
  it('stays quiet in local development', () => {
    warnIfOpenToAnyone(env({ APP_URL: 'http://localhost:5173' }));
    expect(warn).not.toHaveBeenCalled();
  });

  /** The open door said out loud, which is the case the warning has nothing to tell. */
  it('stays quiet once an instance declares its sign-ups public', () => {
    warnIfOpenToAnyone(env({ PUBLIC_SIGNUPS: '1' }));
    expect(warn).not.toHaveBeenCalled();
  });

  /** Anything else is not a declaration, so the open door is still an accident. */
  it('warns when the declaration is anything other than 1', () => {
    warnIfOpenToAnyone(env({ PUBLIC_SIGNUPS: '0' }));
    warnIfOpenToAnyone(env({ PUBLIC_SIGNUPS: 'true' }));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

/**
 * Where the deletion mail points.
 *
 * At the SPA, not at Better Auth's `/delete-user/callback`, because that endpoint deletes
 * on a bare GET — and a GET is fired by prefetches, scanners and restored tabs as readily
 * as by people. The page it lands on asks once more and deletes with a POST.
 */
describe('confirmDeletionUrl', () => {
  it('addresses the app, not the API', () => {
    const url = new URL(confirmDeletionUrl(env({ APP_URL: 'https://unbent.app' }), 'tok'));
    expect(url.origin).toBe('https://unbent.app');
    expect(url.pathname).toBe('/delete-account');
    expect(url.searchParams.get('token')).toBe('tok');
  });

  /** Dev serves the SPA on its own port, with the proxy in front of the Worker. */
  it('uses the SPA origin in development', () => {
    const url = new URL(
      confirmDeletionUrl(env({ APP_URL: 'http://localhost:5173' }), 'tok'),
    );
    expect(url.host).toBe('localhost:5173');
    expect(url.pathname).toBe('/delete-account');
  });

  /** A token is opaque and may carry characters a query string would otherwise eat. */
  it('escapes the token rather than pasting it in', () => {
    const url = confirmDeletionUrl(env({ APP_URL: 'https://unbent.app' }), 'a b&c=d');
    expect(url).toContain('token=a+b%26c%3Dd');
    expect(new URL(url).searchParams.get('token')).toBe('a b&c=d');
  });

  /** An instance served from a subpath should keep it rather than jump to the root. */
  it('never points at the deleting GET endpoint', () => {
    const url = confirmDeletionUrl(env({ APP_URL: 'https://unbent.app' }), 'tok');
    expect(url).not.toContain('delete-user/callback');
  });
});

/**
 * Whether the instance offers account deletion at all.
 *
 * The confirmation mail is the guard, so this is really "can we ask?". An instance that
 * cannot send one leaves the endpoint disabled, and `/api/config` says so rather than
 * letting a settings page draw a button that answers 404.
 */
describe('accountDeletionOffered', () => {
  it('offers it where mail is configured', () => {
    expect(
      accountDeletionOffered(env({ RESEND_API_KEY: 'key', EMAIL_FROM: 'a@example.com' })),
    ).toBe(true);
  });

  /** Half a mail configuration is treated as none, the same as everywhere else here. */
  it('refuses it on a deployed instance with no mail', () => {
    expect(accountDeletionOffered(env({}))).toBe(false);
    expect(accountDeletionOffered(env({ RESEND_API_KEY: 'key' }))).toBe(false);
  });

  /** Locally `sendEmail` prints the link, which is how the flow is worked on offline. */
  it('offers it in local development, where the link goes to the console', () => {
    expect(accountDeletionOffered(env({ APP_URL: 'http://localhost:5173' }))).toBe(true);
  });
});
