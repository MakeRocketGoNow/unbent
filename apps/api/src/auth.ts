import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer, deviceAuthorization, emailOTP, jwt, oneTimeToken } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { passkey } from '@better-auth/passkey';
import { socialProviderList } from 'better-auth/social-providers';
import { SIGNUPS_CLOSED_MESSAGE, type AuthProvider } from '@unbent/shared';
import type { Env } from './types.js';
import { canSendEmail, sendEmail } from './lib/email.js';
import { signInCodeEmail } from './lib/sign-in-code-email.js';
import { deleteKeys, deleteUserBlobs } from './lib/blobs.js';
import { ensureDirectoryRow, tombstoneDirectoryRow } from './lib/directory.js';
import { storeFor } from './lib/store-client.js';

/**
 * Emails permitted to create an account, lowercased.
 *
 * Empty means unrestricted, which is what local development wants. Deployed, this is set
 * so that a public URL does not turn into a free notes host for anyone who finds it:
 * OAuth alone would happily sign up any Google or GitHub account in the world.
 */
function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether password sign-in is offered.
 *
 * Two switches for one feature, on purpose. AUTH_PASSWORD is the self-hoster's choice:
 * social providers need a callback URL registered per deployment with Google and GitHub,
 * which nobody can do on behalf of every instance, so a password is the one method that
 * works everywhere. ALLOW_TEST_CREDENTIALS stays as the test suite's own switch — it is
 * documented as local-only, and folding it into the real flag would invite setting the
 * real flag on a deployed instance "for the tests".
 *
 * And a default underneath both, because opt-in alone left a hole. A passkey cannot create
 * an account — one is added from settings once you are already signed in — and a code by
 * email needs a mail provider. So an instance deployed with no OAuth, no Resend and no
 * AUTH_PASSWORD offered exactly one button, which could not work for anyone who did not
 * already have an account, and on a fresh instance that is everyone including the operator.
 * Nothing said so; it simply dead-ended. Password is now the floor: offered when nothing
 * else here can create an account, and standing aside the moment something can.
 *
 * That the default disappears as soon as a real method exists is the point. An instance
 * with Google configured is unchanged, and so is unbent.app — the open sign-up this would
 * otherwise hand a public URL is exactly what made it opt-in in the first place, and
 * ALLOWED_EMAILS is still what governs who may take it up.
 *
 * `AUTH_PASSWORD=0` is the way to refuse the default, for an instance that wants passkeys
 * and nothing else for the people who already have accounts. It is checked before the test
 * switch so that an explicit no wins over an implicit yes, and it is the one setting here
 * that can still leave nobody a way in — deliberately, the same as `AUTH_PASSKEY=0`.
 */
function passwordEnabled(env: Env): boolean {
  if (env.AUTH_PASSWORD === '1') return true;
  if (env.AUTH_PASSWORD === '0') return false;
  if (env.ALLOW_TEST_CREDENTIALS === '1') return true;
  return configuredSocials(env).length === 0 && !codesDeliverable(env);
}

/**
 * Passkeys, on unless an instance says otherwise.
 *
 * Nothing has to be registered anywhere for a passkey to work — WebAuthn's other half is
 * the browser and the user's own device — so there is no missing credential to infer an
 * operator's intent from, and this is the one method that has to be opt-out rather than
 * opt-in. It gates both the advertisement and the endpoints: an operator who turns this
 * off means off, not hidden.
 */
function passkeysEnabled(env: Env): boolean {
  return env.AUTH_PASSKEY !== '0';
}

/**
 * Whether codes by email can reach anyone from here.
 *
 * Configured mail, or local development — where `sendEmail` prints the code to the Worker
 * console instead of sending it. Without the second half the feature could not be worked
 * on without a Resend account, since the same check decides both whether OTP is offered
 * and whether mail is real. A deployed instance with no mail still does not offer it.
 */
function codesDeliverable(env: Env): boolean {
  return canSendEmail(env) || env.APP_URL.startsWith('http://localhost');
}

/**
 * Whether this instance lets an account delete itself.
 *
 * The same test as codes by email, for the reason spelled out on `deleteUser` below: the
 * confirmation mail *is* the guard, so an instance that cannot send one has no way to ask
 * and does not offer the flow. Named separately from `codesDeliverable` because the two
 * answer different questions and only happen to agree — if deletion ever gains a second
 * way to confirm, this is the line that changes.
 *
 * Exported because `/api/config` reports it: a settings page that drew a Delete account
 * button on an instance where the endpoint 404s would be worse than not drawing one.
 */
export function accountDeletionOffered(env: Env): boolean {
  return codesDeliverable(env);
}

/**
 * The sign-in methods this instance offers, in display order.
 *
 * Derived from the same checks `createAuth` makes, so the login screen and the Android
 * app can render from it rather than guessing. The screen used to hardcode Google and
 * GitHub, which only failed at the moment of pressing a button with no credentials behind
 * it. Public, because it is needed before anyone is signed in; nothing here is secret,
 * since a provider's presence is discoverable by trying it.
 */
/**
 * Credentials are looked up by name, so `Env`'s declared keys are not enough.
 *
 * The named fields stay for the ones this code reads directly and wants checked; this is
 * the same object seen as the string map Workers actually hands over.
 */
function envMap(env: Env): Record<string, string | undefined> {
  return env as unknown as Record<string, string | undefined>;
}

/**
 * The OAuth providers this instance has credentials for.
 *
 * Every provider Better Auth ships — thirty-five of them — is available by convention
 * rather than by being named here: set `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET`
 * and it appears; delete either and it goes. That convention is not new, it is what Google
 * and GitHub already used; this only stops the list of which providers may use it from
 * being hard-coded.
 *
 * Which matters for a self-hosted instance. Somebody running this for a company on
 * Microsoft, or a community on Discord, should not have to fork the repository and edit
 * this file to sign in — and every provider they might want is already sitting in the
 * dependency, waiting to be named by an environment variable.
 */
export function configuredSocials(env: Env): string[] {
  const vars = envMap(env);
  return socialProviderList.filter((id) => {
    const key = id.toUpperCase();
    return Boolean(vars[`${key}_CLIENT_ID`] && vars[`${key}_CLIENT_SECRET`]);
  });
}

/**
 * Origins outside this instance that may POST to the auth routes, one per provider that
 * needs it.
 *
 * Apple is the only one. Its web sign-in ends with `response_mode=form_post`: Apple's own
 * page submits the result to `/api/auth/callback/apple`, so the request arrives with
 * `Origin: https://appleid.apple.com`. A deployed instance trusts only `APP_URL`
 * (`baseURLFor`), so the callback answered `INVALID_ORIGIN` after the person had already
 * approved the sign-in at Apple. Google and the rest come back as a redirect, a GET,
 * which the check never sees.
 *
 * Better Auth checks a POST's origin only when it carries a cookie, which is why a test
 * request without one sails through and the bug shows only in a real browser. A
 * cross-site POST drops this app's own `SameSite=Lax` cookies but still sends any
 * `SameSite=None` one for the host — Cloudflare's bot-management `__cf_bm`, on a zone
 * with Bot Fight Mode, is one — and that is enough to turn the check on.
 *
 * Only while Apple is configured, so an instance without it trusts no one extra. This is
 * Better Auth's `trustedOrigins`, which governs auth requests only: `isTrustedOrigin`,
 * which guards the change feed's socket, stays exactly `APP_URL` and must not take this.
 */
export function providerOrigins(env: Env): string[] {
  return configuredSocials(env).includes('apple') ? ['https://appleid.apple.com'] : [];
}

export function offeredProviders(env: Env): AuthProvider[] {
  const providers: AuthProvider[] = [...configuredSocials(env)];
  if (passwordEnabled(env)) providers.push('password');
  /**
   * Offered only where a code can actually reach someone. A deployed instance with no mail
   * provider would otherwise show a form whose code goes to a log nobody is reading, which
   * is worse than not offering it — the same reasoning the OAuth checks above use.
   */
  if (codesDeliverable(env)) providers.push('email-otp');
  /**
   * On unless an instance says otherwise. A passkey needs nothing registered with anyone —
   * no client id, no secret, no email provider — because WebAuthn's other half is the
   * browser and the user's own device, so there is no configuration that could make it
   * fail. `AUTH_PASSKEY=0` exists only so that an operator who does not want to explain
   * them to their users can leave them out; everything else here is opt-in, and this is
   * the one thing that has to be opt-out.
   */
  if (passkeysEnabled(env)) providers.push('passkey');
  return providers;
}

/**
 * The relying party a passkey is bound to, derived from APP_URL so it cannot drift from
 * the origin the app is actually served on.
 *
 * `rpID` is the bare hostname and `origin` the full URL; WebAuthn checks both, and a
 * mismatch surfaces in the browser as a flat refusal to create or use a credential.
 *
 * A caveat local development has to live with: `baseURLFor` deliberately trusts Tailscale
 * and emulator origins as well, but a credential is bound to exactly one rpID, so a
 * passkey made on localhost will not work over Tailscale and the reverse. Passkeys are
 * testable on localhost, which browsers treat as a secure context despite the http, and
 * that is the supported way to exercise them here.
 */
function relyingParty(env: Env): { rpID: string; origin: string } {
  const url = new URL(env.APP_URL);
  return { rpID: url.hostname, origin: url.origin };
}

/**
 * Local APP_URL names one port, but the SPA may be reached over Tailscale (MagicDNS /
 * 100.x) or from another checkout. OAuth redirect_uri is derived from the request Host,
 * so a sign-in from the public Tailscale URL comes back there instead of localhost.
 * Production keeps a fixed APP_URL.
 *
 * These are also the origins Better Auth trusts, so the Android emulator's alias for
 * the host machine has to be here: the app sends it as `Origin`, and without it every
 * sign-in from an emulator is refused as CSRF with "Invalid origin".
 *
 * The port is a wildcard rather than an enumeration because each git worktree runs its
 * own Vite on a port derived from its directory name (see `scripts/ports.mjs`), and the
 * proxy forwards the browser's Host header verbatim — so the port reaching Better Auth
 * is whichever checkout the request came from. `*` spans a port in Better Auth's matcher
 * (its separator is `/`), which is what `*.ts.net:5173` already relied on.
 *
 * Only the local branch is this permissive: a deployed APP_URL returns above, so
 * production still trusts exactly one origin.
 */
function baseURLFor(env: Env) {
  if (!env.APP_URL.startsWith('http://localhost')) return env.APP_URL;
  return {
    allowedHosts: LOCAL_ALLOWED_HOSTS,
    fallback: env.APP_URL,
    protocol: 'http' as const,
  };
}

/** The hosts a local instance is reached on; see `baseURLFor` for why each is here. */
const LOCAL_ALLOWED_HOSTS = ['localhost:*', '127.0.0.1:*', '10.0.2.2:*', '*.ts.net:*', '100.*.*.*:*'];

/**
 * Whether a browser `Origin` is one this instance serves the app on: the same set
 * Better Auth trusts, so a route that checks an origin itself — the change feed's
 * WebSocket, whose handshake skips CORS — cannot drift from sign-in. Deployed, exactly
 * `APP_URL`'s origin (compared as origins, so a trailing slash on the setting does not
 * refuse every browser); locally, the hosts above on any port, as `baseURLFor` has them.
 */
export function isTrustedOrigin(env: Pick<Env, 'APP_URL'>, origin: string): boolean {
  let url: URL;
  let app: URL;
  try {
    url = new URL(origin);
    app = new URL(env.APP_URL);
  } catch {
    return false;
  }
  if (url.origin === app.origin) return true;
  if (!env.APP_URL.startsWith('http://localhost')) return false;
  return LOCAL_ALLOWED_HOSTS.some((pattern) => {
    // `host:*` is any port. A leading `*.` is any run of labels, as a MagicDNS name has
    // (`laptop.tail1234.ts.net`); a `*` inside a host is one label, so `100.*.*.*` is an
    // address and not a prefix of some other site's name.
    const host = pattern.replace(/:\*$/, '');
    const parts = host.split('*').map((part) => part.replace(/[.]/g, '\\.'));
    const re = new RegExp(`^${parts.map((part, i) => (i === 0 ? part : `${i === 1 && parts[0] === '' ? '.+' : '[^.]+'}${part}`)).join('')}$`);
    return re.test(url.hostname);
  });
}

/**
 * The MCP endpoint's canonical URL, which is also the audience every token issued for it
 * carries.
 *
 * RFC 8707 calls this the resource identifier, and binding tokens to it is what stops one
 * minted for somewhere else being replayed here — the check the MCP route makes on every
 * call. It has to be the URL a client actually types, which is the SPA origin rather than
 * the Worker's own: in production they are the same host, and locally the Vite proxy is
 * what makes the two halves look like one origin.
 *
 * The plugin requires HTTPS with no query or fragment, and allows plain HTTP only on
 * loopback, which is exactly the local-development case.
 */
export function mcpResource(env: Env): string {
  return `${env.APP_URL.replace(/\/$/, '')}/api/mcp`;
}

/** Where tokens for that resource come from, and whose signature they carry. */
export function mcpIssuer(env: Env): string {
  return `${env.APP_URL.replace(/\/$/, '')}/api/auth`;
}

/**
 * What this module actually uses of a Better Auth instance: the catch-all request handler
 * mounted at /api/auth/*, and the session lookup sessionMiddleware performs.
 *
 * Declared explicitly because the plugins below make the inferred return type reference
 * better-call, a transitive dependency this package does not depend on directly, which
 * TypeScript rejects as unportable (TS2742). Naming the surface we rely on is better than
 * pinning someone else's dependency to satisfy a type it only mentions in passing — and it
 * fails loudly if a future caller reaches for something not listed here.
 */
interface AuthInstance {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (context: { headers: Headers }) => Promise<{
      user?: { id: string; email: string; name: string; image?: string | null };
    } | null>;
    /**
     * The two discovery documents, which routes/well-known.ts serves from the root. They
     * are reachable through the handler as well, but only under /api/auth — and the
     * clients that read them look at the origin root, which Better Auth's router 404s
     * before a plugin ever sees it.
     */
    getOAuthServerConfig: (context: { request: Request; asResponse: false }) => Promise<unknown>;
    getOpenIdConfig: (context: { request: Request; asResponse: false }) => Promise<unknown>;
    /**
     * The public signing keys, read in-process by the MCP route. Same material the /jwks
     * endpoint publishes, without a Worker having to make an HTTP request to itself.
     */
    getJwks: () => Promise<{ keys: Array<Record<string, unknown>> }>;
    /**
     * Mints a one-time token against the request's session, the same value the
     * `/one-time-token/generate` endpoint returns. Called in-process by the preview relay
     * so it can validate the return origin and mint in one handler, rather than the browser
     * fetching a token and then being trusted to redirect it somewhere safe — see
     * routes/preview-relay.ts. Requires a session on the passed headers and throws
     * otherwise — though the relay route runs `requireAuth` first, so by the time it calls
     * this a session is already proven and a throw means the token store, which it reports
     * as a 500.
     */
    generateOneTimeToken: (context: { headers: Headers }) => Promise<{ token: string }>;
  };
  /**
   * Needed by the MCP route for the base URL it verifies tokens against, and for the
   * database-backed store that rejects a replayed DPoP proof across isolates.
   */
  $context: Promise<{
    baseURL: string;
    internalAdapter: {
      reserveVerificationValue: (data: {
        identifier: string;
        value: string;
        expiresAt: Date;
      }) => Promise<boolean>;
    };
  }>;
}

/**
 * The `socialProviders` object, assembled from the environment.
 *
 * Every entry is the same shape — an id and a secret — with one exception. Google may be
 * given a second client id: an array widens *ID token audience* verification only, and the
 * browser's authorization-code flow still uses the first entry with the secret. The Android
 * app signs in through Credential Manager, which returns a token issued for whichever
 * client id it asked for; that is normally the same web id, so the extra entry matters only
 * if a build asks for its own Android audience. Accepting both means neither choice breaks
 * sign-in.
 *
 * Apple is the same idea with a different key. The iOS app signs in natively and posts the
 * identity token to `sign-in/social`, and a native token's audience is the app's bundle id,
 * not the Services ID the web flow uses as `APPLE_CLIENT_ID`. `APPLE_BUNDLE_ID` names the
 * bundle ids to accept as well. It goes in `audience`, not the provider's own
 * `appBundleIdentifier`: Better Auth takes `audience`, then `appBundleIdentifier`, then the
 * client id, the first one set *replacing* the others, so `appBundleIdentifier` alone would
 * accept the app's tokens and stop accepting the Services ID's. `audience` is read only on
 * the ID-token path; the web code flow never consults it.
 *
 * Providers needing more than a pair — Apple wants a team id, a key id and a signing key,
 * from which its "secret" is a JWT the operator generates — are configured by putting that
 * generated value in `APPLE_CLIENT_SECRET`. That keeps the shape here uniform at the cost
 * of some setup elsewhere, which is the right trade for something done once per instance.
 */
export function socialConfig(env: Env): Record<string, SocialProviderConfig> {
  const vars = envMap(env);
  const config: Record<string, SocialProviderConfig> = {};

  for (const id of configuredSocials(env)) {
    const key = id.toUpperCase();
    const clientId = vars[`${key}_CLIENT_ID`] as string;
    const clientSecret = vars[`${key}_CLIENT_SECRET`] as string;
    if (id === 'google' && env.GOOGLE_ANDROID_CLIENT_ID) {
      config[id] = { clientId: [clientId, env.GOOGLE_ANDROID_CLIENT_ID], clientSecret };
    } else if (id === 'apple' && appleBundleIds(env).length > 0) {
      config[id] = { clientId, clientSecret, audience: [clientId, ...appleBundleIds(env)] };
    } else {
      config[id] = { clientId, clientSecret };
    }
  }

  return config;
}

type SocialProviderConfig = {
  clientId: string | string[];
  clientSecret: string;
  audience?: string[];
};

/**
 * `APPLE_BUNDLE_ID` as a list. One deployment can be asked for by more than one build: the
 * debug app is a separate bundle id (`….debug`), and it is pointed at production as often
 * as at a local instance, so an instance that accepted one id only would refuse whichever
 * build it was not set up for with nothing in the error to say why.
 */
function appleBundleIds(env: Env): string[] {
  return (env.APPLE_BUNDLE_ID ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Says out loud that a deployed instance will accept a sign-up from anyone.
 *
 * An empty `ALLOWED_EMAILS` means unrestricted. That is what local development and the
 * test suite want, and what a public URL almost never does — but nothing ever said so, and
 * an instance with an open door looks exactly like one without. The silence got worse when
 * password became the floor: an instance that configured nothing now has a sign-up form it
 * did not ask for.
 *
 * A warning and not a refusal, deliberately. Refusing sign-ups without an allowlist would
 * lock an operator out of their own fresh deployment, which is the dead end this change set
 * exists to remove — it would trade a silent open door for a silent locked one. The offered
 * methods are named because that is the part worth acting on: it says what an unknown
 * visitor could actually use.
 *
 * `PUBLIC_SIGNUPS=1` is how an instance says the open door is the point. Without it this
 * cannot tell an instance that decided to be public from one that forgot its allowlist, and
 * on the first of those it becomes a recurring line about a settled decision — which is how
 * a warning stops being read, taking the forgotten-allowlist case down with it. An absent
 * secret cannot express intent; a flag that is present can.
 *
 * It silences and does not enable. Sign-ups are already open whenever the allowlist is
 * empty, and requiring this to open them would lock out the fresh deployment the paragraph
 * above refuses to lock out. Nothing else reads it, deliberately: a declaration that also
 * gated something would be load-bearing, and then setting it to quiet the log would change
 * who can sign in.
 *
 * Exported for its test. It is a plain function of the environment, and which of the four
 * cases it fires on is exactly the kind of condition that rots quietly — too loud and every
 * local run is noise, too quiet and a public instance says nothing.
 */
export function warnIfOpenToAnyone(env: Env): void {
  if (env.APP_URL.startsWith('http://localhost')) return;
  if (env.PUBLIC_SIGNUPS === '1') return;
  if (allowedEmails(env).length > 0) return;
  console.warn(
    `[auth] ALLOWED_EMAILS is empty and APP_URL (${env.APP_URL}) is not local: ` +
      `anyone able to use ${offeredProviders(env).join(', ')} can create an account here.`,
  );
}

/**
 * The page the deletion mail links to.
 *
 * Not Better Auth's own `/delete-user/callback`, deliberately. That endpoint is a GET that
 * deletes, and a GET that deletes is something anything can fire: a link prefetch, a
 * scanner, a restored tab, a thumb landing an inch off. The session requirement rules out
 * the ones that arrive without cookies, but not the case that matters — webmail read in the
 * very browser that holds the session, where a speculative fetch carries them.
 *
 * So the mail points at the SPA instead, which asks once more and then deletes with a POST.
 * That is the shape `/reset-password` already has here, and for the same reason: an emailed
 * token names an intention, and the click that acts on it should be a person's.
 *
 * Built from `APP_URL` rather than from the URL Better Auth hands us, which addresses the
 * API. Same origin in production, and in dev the SPA is the port with the proxy in front.
 */
export function confirmDeletionUrl(env: Env, token: string): string {
  const link = new URL('/delete-account', env.APP_URL);
  link.searchParams.set('token', token);
  return link.toString();
}

/**
 * Better Auth must be constructed per-request: on Workers the D1 binding only exists on
 * `env`, which is not available at module scope. Instances are cheap, but we memoize per
 * Env object so repeated middleware calls within one request reuse the same instance.
 *
 * That memoization is also what paces the warning below. There is no startup hook on
 * Workers to hang it from, and `getAuth` builds one instance per `Env`, so this lands about
 * once per isolate. Do not move it to the request path, where it would repeat forever.
 */
function createAuth(env: Env): AuthInstance {
  warnIfOpenToAnyone(env);
  return betterAuth({
    // Better Auth v1.5+ accepts a D1 binding directly and picks its own dialect.
    // D1 has no interactive transactions; Better Auth falls back to batch() for atomicity.
    database: env.DB,
    baseURL: baseURLFor(env),
    // Apple's callback is a cross-origin POST; see providerOrigins.
    trustedOrigins: providerOrigins(env),
    secret: env.BETTER_AUTH_SECRET,
    // Off unless the instance asks for it; see passwordEnabled. The sign-up allowlist
    // below applies to password accounts exactly as it does to OAuth ones.
    emailAndPassword: {
      enabled: passwordEnabled(env),
      /**
       * Password reset, which until now did not exist: someone who forgot theirs had no
       * way back into their notes short of asking whoever runs the instance. This is the
       * reason the Worker needs to send mail at all.
       *
       * Better Auth handles the token — one-time, stored in `verification`, an hour by
       * default — so what is left here is delivery. Failures propagate: if Resend rejects
       * the message, the caller is told the reset could not be sent rather than being
       * left waiting for mail that is never coming.
       *
       * `revokeSessionsOnPasswordReset` is on because a reset is what someone does when
       * they suspect their account is not only theirs, and leaving the other sessions
       * signed in would defeat the point of the exercise.
       */
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await sendEmail(env, {
          to: user.email,
          subject: 'Reset your Unbent password',
          text: `Someone asked to reset the password for your Unbent account.\n\n${url}\n\nThe link works once and expires in an hour. If this was not you, you can ignore this email — nothing has changed.`,
        });
      },
      revokeSessionsOnPasswordReset: true,
      /**
       * Make people prove they own the address before the account works.
       *
       * Gated on mail being real — `canSendEmail`, not `codesDeliverable` — because this
       * one has a lockout failure mode the others do not: switched on without a way to
       * send the link, every new account is created and then permanently unable to sign
       * in. That also keeps it off locally, where the isolation suite signs up throwaway
       * actors and uses the session immediately.
       *
       * What it is actually for: stopping someone signing up with an address they do not
       * own. On unbent.app `ALLOWED_EMAILS` already does that and passwords are off
       * entirely, so this is for self-hosted instances, which are the ones running open
       * registration.
       *
       * It is worth being precise about what this does not do. It was suggested as a fix
       * for the pre-account-hijacking advisories, and GHSA-g38m-r43w-p2q7 says outright
       * that `requireEmailVerification: true` alone does not mitigate it — the OAuth
       * auto-link gate was the bug, and the fix was the version bump. This narrows who
       * can create an account; it is not a patch.
       *
       * One consequence to know about before turning mail on: password accounts created
       * before this point have `emailVerified` 0, so configuring Resend on an existing
       * self-hosted instance starts asking those people to confirm an address they have
       * been using for months. They are not locked out — a sign-in attempt sends the link
       * — but it arrives unannounced. OAuth accounts are unaffected, since the provider
       * vouches for the address at creation.
       */
      requireEmailVerification: canSendEmail(env),
    },
    emailVerification: {
      /**
       * Sent on sign-up, and again on any sign-in attempt by an unverified account, so
       * someone who lost the first one is not stuck with no way to ask for another.
       */
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        await sendEmail(env, {
          to: user.email,
          subject: 'Confirm your email for Unbent',
          text: `Confirm this address to finish setting up your Unbent account.\n\n${url}\n\nIf you did not sign up, you can ignore this email — the account cannot be used until someone follows this link.`,
        });
      },
      // Straight into the app from the link, rather than back to a sign-in screen to type
      // a password that was already given a moment ago.
      autoSignInAfterVerification: true,
    },
    /**
     * Built from whatever credentials the environment holds — see `configuredSocials`.
     * Adding a provider is `wrangler secret put DISCORD_CLIENT_ID` and its secret, and
     * removing one is deleting either; neither touches this file.
     */
    socialProviders: socialConfig(env),
    /**
     * The allowlist gate.
     *
     * Hooked on user *creation* rather than sign-in, so it costs nothing on the ordinary
     * path: existing users never touch it, and an account that was never created cannot
     * sign in. Throwing beats returning `false`, which Better Auth turns into a null
     * create the caller reports as a generic failure — this way the visitor is told they
     * are not on the list rather than seeing something that looks like a bug.
     */
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email?: string }) => {
            const allowed = allowedEmails(env);
            if (allowed.length === 0) return;
            const email = user.email?.toLowerCase();
            if (email && allowed.includes(email)) return;
            /**
             * The `code` is what gets this refusal back to the sign-in screen. The OAuth
             * callback route redirects to the client's `errorCallbackURL` only for an
             * `APIError` whose body has a code, and re-throws any other — which the
             * browser then showed as a bare JSON 403 at `/api/auth/callback/google`, the
             * message in it and no way back. The code and password routes answer the
             * same body as JSON, where the screen reads `message`; they are unaffected.
             * The screen maps the code to its own sentence (`refusalMessage` in
             * `Login.tsx`) rather than showing `error_description` from the URL, which
             * anyone can write.
             */
            throw new APIError('FORBIDDEN', {
              code: 'SIGNUPS_CLOSED',
              message: SIGNUPS_CLOSED_MESSAGE,
            });
          },
          /**
           * Every account gets a directory row the moment it exists, so the sweep can find
           * its note store from the first day. The object itself is created lazily, by the
           * first request that names the user; nothing to do for it here. See
           * lib/directory.ts.
           */
          after: async (user: { id: string }) => {
            try {
              await ensureDirectoryRow(env.DB, user.id);
            } catch (err) {
              // The sweep heals a missing row within the hour, so a failed write here must
              // not fail the sign-up the user row already succeeded at.
              console.error(`directory row for ${user.id} not written; the sweep will add it:`, err);
            }
          },
        },
      },
    },
    session: {
      // Thirty days, slid forward at most once a day — so ordinary use keeps a session
      // alive indefinitely and only a month of genuine absence signs you out.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      /**
       * Serve the session from a signed cookie for five minutes before re-reading D1.
       *
       * Without this every request that touches auth hits the database, and a failed or
       * cold read surfaces as a sign-out rather than a slow request — the most likely
       * explanation for sessions that lapsed well before their recorded expiry, which in
       * the local database was always a full thirty days.
       *
       * Signed with the same secret, and a read-through cache only: revocation still
       * takes effect within `maxAge`.
       */
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    /**
     * Count rate limits in D1 rather than in memory.
     *
     * Better Auth enables limiting in production by default but stores the counters in the
     * isolate's memory, which on Workers means they are effectively not stored at all:
     * every isolate has its own, and they are spun up and discarded constantly, so an
     * attacker's requests mostly land on a fresh counter. The stricter rule Better Auth
     * puts on /sign-in/email — three attempts in ten seconds — is the thing standing
     * between a password and an online guessing attack, and it only actually holds if the
     * count is somewhere shared. `rateLimit` in migration 0011 is that somewhere.
     *
     * Left disabled in dev, which is the upstream default and what the test suite needs:
     * the isolation suite signs actors in far faster than three times in ten seconds.
     */
    rateLimit: { storage: 'database' },
    advanced: {
      // The SPA and API are same-origin in both dev and production, so a host-only
      // cookie is sufficient and avoids SameSite=None.
      useSecureCookies: !env.APP_URL.startsWith('http://localhost'),
      database: {
        /*
         * Better Auth compares its tables with the database's whenever a Worker instance
         * starts: one read of sqlite_master and a `pragma_table_info` for every table,
         * the full-text indexes' shadow tables included — about 47 statements and 420
         * rows before the first request can be answered. Instances start often, on
         * production, the dev instance and every preview, all against one account's
         * Workers Free quota: about 86k rows a day across the two databases, to check a
         * schema that apps/api/migrations owns and `wrangler d1 migrations apply` has
         * already put in place. Kept on a local instance, which is free, and where a
         * Better Auth upgrade that needs a migration is caught before it ships.
         */
        validateSchema: env.APP_URL.startsWith('http://localhost'),
      },
    },
    user: {
      /**
       * Deleting an account, and why it takes an email to do it.
       *
       * Better Auth's `/delete-user` verifies a password only if the caller sends one.
       * With nothing else configured, the entire guard on a bare POST is `freshAge` — a
       * 24-hour window measured from when the session was created, not from when it was
       * last used — and that is the wrong shape at both ends.
       *
       * Inside the window an empty POST carrying a session token deletes the account and
       * everything under it. The Android app and the CLI both send that token as
       * `Authorization: Bearer`, and the bearer plugin below turns it back into a session
       * on every endpoint, so a token that leaks in its first day is a whole-account wipe
       * with no confirmation of any kind. `purge-notes` asks for `?confirm=DELETE` before
       * emptying the trash; this asks for nothing before emptying the account.
       *
       * Outside the window nobody without a password can delete at all: the no-password
       * path is refused as stale, and sending a password finds no credential row to check
       * it against. That is every Google, GitHub and passkey account — on unbent.app, all
       * of them.
       *
       * `sendDeleteAccountVerification` replaces both with one rule that does not depend
       * on how someone signed in: the request only ever sends mail, and the deletion
       * happens when the link comes back. The link is a GET, which would be a mistake on
       * its own since mail scanners follow links, except that the callback resolves the
       * session before it consumes the token — a fetch without the signed-in browser's
       * cookie fails and leaves the token unspent.
       *
       * Gated on `codesDeliverable` rather than simply on, because here the mail *is* the
       * confirmation: an instance that cannot deliver it has no way to ask, so it does not
       * offer the flow — the same line `emailOTP` draws, and the same reason locally is
       * enough, `sendEmail` printing the link to the Worker console.
       */
      deleteUser: {
        enabled: accountDeletionOffered(env),
        /**
         * Deliberately blunt about what is about to happen: this is the one action in the
         * app with no undo and no trash to fish it back out of, and the mail is the last
         * point at which someone can change their mind.
         */
        sendDeleteAccountVerification: async ({
          user,
          token,
        }: {
          user: { email: string };
          token: string;
        }) => {
          await sendEmail(env, {
            to: user.email,
            subject: 'Confirm deleting your Unbent account',
            text: `Someone asked to delete your Unbent account.\n\n${confirmDeletionUrl(env, token)}\n\nThat link opens a page asking you to confirm. Confirming deletes the account, every note in it and every file attached to one — there is no undo and no export afterwards, so take one first if you want one. Open it in the browser you are signed in with; it does nothing anywhere else.\n\nThe link works once and expires in a day. If this was not you, ignore this email. Nothing has happened, and nothing will: opening the link on its own deletes nothing.`,
          });
        },
        /**
         * Sweep R2 and wipe the note store before the user row is deleted.
         *
         * D1 handles its own cleanup — sessions, accounts, upload links all have
         * `ON DELETE CASCADE` — but R2 has no foreign keys and the notes live in an object
         * of the account's own, and neither can be reached by anything once the account is
         * gone. This is the hook that prevents the "stranded blobs" gap the README used to
         * document, and now the stranded-object one.
         *
         * Blobs and store before rows here, which is the reverse of what `purge-notes`
         * does, and the reversal is the whole design. There the rows go first because a
         * failure afterwards leaves orphans that gc-blobs can still reclaim; here the user
         * id the sweep needs is the thing the deletion is about to destroy, so after the
         * row is gone nothing can reach the prefix again. The cost is the mirror image: if
         * this throws, Better Auth abandons the deletion and the account survives carrying
         * attachment rows that point at objects already deleted, or an empty store. That
         * is the recoverable half — the owner can ask again — and it is why the failure is
         * logged rather than swallowed.
         *
         * The object first would be wrong: its rows are what `gc-blobs` reads to know
         * which objects are referenced, and an account that survived a failed blob sweep
         * with its rows gone could never find its files again.
         */
        beforeDelete: async (user: { id: string }) => {
          try {
            await deleteUserBlobs(env.BLOBS, user.id);
          } catch (err) {
            // The rethrow is what stops the deletion. The log is so a half-swept account
            // can be found afterwards: the id is the only way back to the prefix that
            // still needs finishing, and by then there is no row to look it up from.
            console.error(`Blob sweep failed for ${user.id}; account deletion abandoned:`, err);
            throw err;
          }
          try {
            await storeFor(env, user.id).wipe();
          } catch (err) {
            console.error(`Store wipe failed for ${user.id}; account deletion abandoned:`, err);
            throw err;
          }
        },
        /**
         * Tombstone the directory row once the user row is gone. The row is what the
         * sweep retries the wipe from if the object was reset between the wipe above and
         * this, and it is dropped by the sweep once the object reports itself empty. A
         * directory row whose `user` row is missing is treated as tombstoned by the sweep
         * too, so this hook failing cannot strand an object either.
         */
        afterDelete: async (user: { id: string }) => {
          try {
            await tombstoneDirectoryRow(env.DB, user.id);
          } catch (err) {
            // The user row is already gone, so the deletion has happened and must not be
            // reported as failed; the sweep treats a row whose user is missing as
            // tombstoned, so the wipe is still retried from it.
            console.error(`directory tombstone for ${user.id} not written; the sweep will treat it as gone:`, err);
          }
        },
      },
    },
    plugins: [
      /**
       * Lets a CLI sign in without ever handling a credential: it prints a short code,
       * the user approves it in a browser already signed in here, and the CLI collects an
       * ordinary session. Nothing is typed into or stored by the CLI.
       *
       * Approval requires a real session, so the sign-up allowlist above governs this
       * path too — a device cannot be authorized by someone who could not sign in.
       *
       * Defaults are the plugin's: a 30-minute code and 5-second polling. Both suit a
       * migration the user starts and then watches.
       */
      deviceAuthorization(),
      /**
       * Accepts `Authorization: Bearer <token>` as an alternative to the session cookie.
       *
       * The device flow issues a normal session; without this the CLI would have to
       * store and replay a cookie, which is the browser's mechanism rather than an HTTP
       * client's. Everything downstream is unchanged either way — sessionMiddleware still
       * resolves a user and `requireAuth` still guards the same routes.
       */
      bearer(),
      /**
       * Signing keys for the OAuth tokens the MCP plugin issues, published as a public key
       * set at /api/auth/jwks.
       *
       * Required by the provider below rather than optional: it is what lets the MCP route
       * verify a token by checking a signature instead of reading the database on every
       * tool call, which matters when a single agent turn makes a dozen of them.
       */
      jwt(),
      /**
       * Makes this instance an OAuth 2.1 authorization server, so an AI assistant can be
       * given access to someone's notes.
       *
       * This is a different shape of trust from every other plugin here. The others sign a
       * person in; this one lets a *program* act as that person indefinitely, which is why
       * the flow ends at a consent screen naming what is being granted and why settings
       * has a page for taking it back.
       *
       * Registration is open, and deliberately: Claude, Cursor and the rest register
       * themselves at connect time and there is no way to pre-provision credentials for
       * clients you have never heard of. That means unauthenticated writes to `oauthClient`
       * from anyone who can reach the URL, so registration is rate limited below. It buys
       * nothing on its own — a registered client with no approved consent can read nothing
       * — but a table that grows without a human in the loop should not grow quickly.
       *
       * The newer CIMD scheme, where a client is identified by a document on its own
       * domain, is the direction this is heading and is not here yet: it needs a
       * Workers-specific fetch transport the package does not ship.
       */
      mcp({
        loginPage: '/login',
        consentPage: '/consent',
        resource: mcpResource(env),
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        rateLimit: {
          // Ten registrations a minute per address. A real client registers once.
          register: { window: 60, max: 10 },
        },
      }),
      /**
       * Lets a signed-in browser hand a session to a native app without the user reading
       * anything out.
       *
       * The phone opens /connect in a Custom Tab, which is already signed in through the
       * browser's own cookies whatever provider was used to get there — Google, GitHub, or
       * anything added later. That page mints one of these, and the app redeems it for an
       * ordinary session. The device-code flow stays for the CLI, which has no browser to
       * hand anything back to.
       *
       * Three minutes is the plugin's default and is right here: the token's whole life is
       * one redirect back into the app.
       */
      oneTimeToken(),
      /**
       * Passkeys: the sign-in that is both the least work for the user and the hardest to
       * steal. One touch of a fingerprint sensor, no password manager to open, no code to
       * copy from another app — and because the credential is bound to this origin by the
       * browser, there is nothing to phish and nothing on the server worth stealing. Only
       * a public key is stored here.
       *
       * Additive rather than a replacement: a passkey is created from settings once you
       * are already signed in, so every account still has whatever method got it here.
       * That also keeps the recovery story simple — lose the device, use the password.
       */
      ...(passkeysEnabled(env) ? [passkey({ rpName: 'Unbent', ...relyingParty(env) })] : []),
      /**
       * A six-digit code by email: the way in that needs no account anywhere else.
       *
       * This is what lets unbent.app drop GitHub without becoming Google-only. Passkeys
       * cannot fill that role — one has to be added from an account you already have — so
       * a code is the only method here that can *create* an account unaided.
       *
       * Chosen over a magic link because of the phone. A link tapped in a mail app opens
       * in whatever browser that app prefers, which is frequently not the one holding the
       * session, and on Android the app's Custom Tab is a third context again. A code is
       * typed into whatever asked for it, so it cannot land in the wrong place.
       *
       * Sign-up and sign-in are deliberately the same flow: an address with no account
       * gets one. `ALLOWED_EMAILS` still governs that, through the same creation hook as
       * every other method, which is what keeps a public URL from becoming a free host.
       *
       * Registered only where codes are deliverable, the same way a social provider with
       * no credentials is left out rather than mounted and left to fail: an endpoint that
       * accepts a request, reports success and sends nothing is worse than one that is
       * not there, because the caller has no way to tell the difference.
       *
       * Note this instance may run OTP and passwords together, the combination behind
       * GHSA-qq9h-g4jm-xgf3, where an attacker pre-registered a password on a victim's
       * address and kept access after the victim verified by code. Fixed in 1.6.22 and so
       * in the 1.7.1 pinned here: the passwordless path now clears the password and
       * revokes sessions before marking an account verified.
       */
      ...(codesDeliverable(env) ? [emailOTP({
        // Six digits for five minutes, both the plugin's defaults and right for a code
        // read off a phone. Three attempts before it is burned, also the default.
        sendVerificationOTP: async ({ email, otp }: { email: string; otp: string }) => {
          await sendEmail(env, { to: email, ...signInCodeEmail(otp) });
        },
        /**
         * Hashed rather than the default plain, so the codes are not readable in the
         * database. They live five minutes, but a stored credential that could be used
         * as-is is worth avoiding whatever its lifetime.
         */
        storeOTP: 'hashed',
      })] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const cache = new WeakMap<Env, Auth>();

export function getAuth(env: Env): Auth {
  const existing = cache.get(env);
  if (existing) return existing;
  const auth = createAuth(env);
  cache.set(env, auth);
  return auth;
}
