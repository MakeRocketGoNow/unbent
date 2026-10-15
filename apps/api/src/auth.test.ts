import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountDeletionOffered,
  configuredSocials,
  getAuth,
  offeredProviders,
  providerOrigins,
  socialConfig,
  confirmDeletionUrl,
  warnIfOpenToAnyone,
} from './auth.js';
import type { Env } from './types.js';
import { verifyProviderIdToken } from 'better-auth/oauth2';
import { apple } from 'better-auth/social-providers';

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

/**
 * The iOS app's identity tokens name its bundle id as their audience, the web flow's the
 * Services ID. Each case goes through Better Auth's own Apple provider, because what
 * matters is the audience *it* verifies against — its `appBundleIdentifier` option looks
 * like the answer and replaces the Services ID instead of adding to it.
 */
describe('socialConfig for Apple', () => {
  const web = { APPLE_CLIENT_ID: 'com.example.notes.web', APPLE_CLIENT_SECRET: 'jwt' };
  const provider = (vars: Record<string, string>) =>
    apple(socialConfig(env(vars)).apple as Parameters<typeof apple>[0]);

  it('accepts the Services ID alone when no bundle id is set', () => {
    expect(socialConfig(env(web)).apple).not.toHaveProperty('audience');
    expect(provider(web).idToken.audience).toBe('com.example.notes.web');
  });

  it('accepts every listed bundle id beside the Services ID', () => {
    expect(
      provider({ ...web, APPLE_BUNDLE_ID: 'com.example.notes, com.example.notes.debug' }).idToken
        .audience,
    ).toEqual(['com.example.notes.web', 'com.example.notes', 'com.example.notes.debug']);
  });

  it('configures nothing for a bundle id without Apple', () => {
    expect(socialConfig(env({ APPLE_BUNDLE_ID: 'com.example.notes' }))).toEqual({});
  });

  /**
   * The whole path `sign-in/social` takes with an `idToken`, short of fetching Apple's
   * keys: a token signed here stands in for one from Apple. The app puts the SHA-256 of
   * its nonce in the authorization request and posts the raw nonce, which is what Apple's
   * `exact-or-sha256` comparison exists for.
   */
  it('verifies a native token for the bundle id, with its hashed nonce', async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const nonce = 'raw-nonce';
    const sign = (claims: Record<string, unknown>) => es256(keys.privateKey, claims);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://appleid.apple.com',
      sub: '000000.abc.0000',
      iat: now,
      exp: now + 600,
      nonce: await sha256Hex(nonce),
    };
    const verify = async (vars: Record<string, string>, token: string, sent = nonce) => {
      const p = provider(vars);
      const local = { ...p, idToken: { ...p.idToken, jwks: async () => keys.publicKey } };
      return verifyProviderIdToken(local, token, sent, {} as never);
    };
    const withApp = { ...web, APPLE_BUNDLE_ID: 'com.example.notes' };
    const appToken = await sign({ ...claims, aud: 'com.example.notes' });

    expect(await verify(withApp, appToken)).toBe(true);
    // The web Services ID still verifies with the bundle id configured.
    expect(await verify(withApp, await sign({ ...claims, aud: 'com.example.notes.web' }))).toBe(
      true,
    );
    // Without APPLE_BUNDLE_ID the same app token is refused, which is the bug this fixes.
    expect(await verify(web, appToken)).toBe(false);
    expect(await verify(withApp, appToken, 'another-nonce')).toBe(false);
    expect(await verify(withApp, await sign({ ...claims, aud: 'com.example.other' }))).toBe(false);
  });
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A compact ES256 JWT, signed with Web Crypto rather than a JOSE library. */
async function es256(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${part({ alg: 'ES256', kid: 'test' })}.${part(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

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

/**
 * The D1 adapter's connection lock; see `database` in auth.ts. Kysely serialises every
 * query of an adapter that reports one connection, and the lock lives on the Better Auth
 * instance every request of an isolate shares. A query that never settles — a request
 * cancelled mid-flight — then holds every later one. `patches/` makes the D1 adapter
 * report several connections, and this is what fails if an upgrade brings the lock back.
 *
 * The fake D1 answers nothing to its first query and everything to the rest. Unpatched,
 * the second query never reaches it, so the answer is the proof, not
 * the timeout, which only keeps a regression from hanging the suite.
 */
describe('the D1 adapter runs queries concurrently', () => {
  it('lets a query through while an earlier one has not settled', async () => {
    // Plugins query the store while the instance is set up (the MCP plugin reads its
    // resource row), so it is the first *session* query that never answers, not the first.
    let calls = 0;
    const statement = (sql: string) => {
      const self = {
        bind: () => self,
        all: () => (/\bsession\b/i.test(sql) && ++calls === 1 ? new Promise<never>(() => {}) : Promise.resolve({ results: [], meta: {} })),
        first: async () => null,
        run: async () => ({ results: [], meta: {} }),
        raw: async () => [],
      };
      return self;
    };
    const DB = { prepare: statement, batch: async () => [], exec: async () => ({}), withSession: () => DB, dump: async () => new ArrayBuffer(0) };
    // Deployed shape: on a localhost `APP_URL` Better Auth would check the schema first,
    // through this same adapter, and that check would be the query that never settles.
    const auth = getAuth(env({ BETTER_AUTH_SECRET: 'test-secret', DB } as unknown as Record<string, string>));
    const ctx = (await auth.$context) as unknown as { adapter: { findOne: (q: unknown) => Promise<unknown> } };
    const find = () => ctx.adapter.findOne({ model: 'session', where: [{ field: 'token', value: 'never' }] });

    void find().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const second = await Promise.race([
      find().then(() => 'answered'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('still waiting'), 2_000);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(second).toBe('answered');
    expect(calls).toBe(2);
  });
});
