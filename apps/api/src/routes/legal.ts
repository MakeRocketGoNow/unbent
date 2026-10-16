import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { coversLegalVersion } from '@unbent/shared';
import { z } from 'zod';
import { getAuth } from '../auth.js';
import { legalLinksOf } from '../lib/instance.js';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

const agreeBody = z.object({ version: z.string().min(1).max(64) });

/**
 * Recording that someone agreed to the terms and privacy policy (MAK-209).
 *
 * The version in the body must be the one this instance publishes right now. An app
 * holding an older config, open in a tab across a deploy that moved `LEGAL_VERSION`,
 * would otherwise record agreement to documents it never showed, so it is told 409 and
 * reloads the config, which shows the new ones. The time is the server's, never the
 * client's: it is the record of when, kept for every version in `legal_agreement`.
 *
 * The answer carries a fresh session cookie. The session is served from a signed cookie
 * for up to five minutes (`cookieCache` in `auth.ts`), and that cookie still says the
 * account has not agreed; without replacing it, the app would ask again the moment it
 * re-read the session. Passing the request through Better Auth's own `get-session` with the
 * cache bypassed reads the row just written and sets the cookie from it, the same thing
 * `/update-user` does after a change of name, and through the handler rather than a new
 * entry on `AuthInstance`, since it is one request rather than an API this module calls.
 */
export const legal = new Hono<AppEnv>().post('/legal/agree', requireAuth, async (c) => {
  const current = legalLinksOf(c.env)?.version;
  // Nothing is published here, so there is nothing to agree to: the app never asks.
  if (!current) return c.json({ error: 'This instance publishes no terms to agree to.' }, 404);

  const parsed = agreeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Say which version you are agreeing to.' }, 400);
  if (parsed.data.version !== current) {
    return c.json({ error: 'The terms have changed since this page loaded.', version: current }, 409);
  }

  // The history first, then the version the session carries, in one batch. `OR IGNORE`
  // keeps the first time each version was agreed to: a second press (another device, or
  // a tab still holding the cached session) must not move it. See migration 0044.
  const userId = c.get('userId')!;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO legal_agreement (user_id, version, agreed_at) VALUES (?, ?, ?)').bind(
      userId,
      current,
      new Date().toISOString(),
    ),
    c.env.DB.prepare('UPDATE user SET legalVersion = ? WHERE id = ?').bind(current, userId),
  ]);

  // Only the cookie: this is a GET of the session, and the POST's own headers (its body's
  // type and length among them) describe a request it is not.
  const cookie = c.req.header('cookie');
  const refreshed = await getAuth(c.env).handler(
    new Request(new URL('/api/auth/get-session?disableCookieCache=true', c.req.url), {
      headers: cookie ? { cookie } : {},
    }),
  );
  const cookies = refreshed.headers.getSetCookie();
  /*
   * Said out loud rather than answered 200. Without a fresh cookie the app re-reads the
   * cached session, which still says nothing was agreed, and the screen stays put with no
   * word of why. Pressing again is the remedy, and it works: the agreement is already
   * saved, so a second press only retries this refresh. A request with no cookie at all
   * (a bearer session) has no cache to replace, and nothing is missing.
   */
  if (!refreshed.ok || (cookie && cookies.length === 0)) {
    return c.json(
      { error: 'Your agreement was saved, but this device could not be updated. Press Agree again.' },
      503,
    );
  }
  for (const set of cookies) c.header('Set-Cookie', set, { append: true });
  return c.json({ version: current });
});

/**
 * The two Better Auth endpoints that hand a program a credential of its own: approving an
 * OAuth client (an assistant connecting over MCP) and approving a CLI's device code. Both
 * are POSTs, and both outlive the session that made them.
 */
const GRANTS: ReadonlySet<string> = new Set(['/api/auth/oauth2/consent', '/api/auth/device/approve']);

/**
 * Refuses a new credential to an account that has not agreed to the current terms.
 *
 * The app already asks before either of these: the consent page and `/device` are inside
 * the signed-in shell, which shows the agreement first. This is the same rule for a client
 * that calls the endpoints directly, which could otherwise sign in with a code and mint a
 * long-lived token without ever being shown the terms. Grants that already exist keep
 * working (refusing them would break a connected assistant mid-task over a page it cannot
 * press) and so does refusing a consent (`accept: false`), which grants nothing.
 *
 * In front of Better Auth's handler rather than in one of its hooks, because the session
 * is already resolved here (`sessionMiddleware`) and the check is this app's rule, not
 * Better Auth's. The paths are its plugins' own, so an upgrade that renamed one would let
 * that grant through unchecked, and this check would go on refusing the old path, so
 * a refusal proves nothing. `test/legal-agreement.test.ts` also calls both once the
 * account has agreed, and fails if either is no longer Better Auth's endpoint.
 *
 * No session, or nothing published to agree to, passes through: Better Auth refuses the
 * first itself, and there is nothing to ask for in the second.
 */
export const refuseGrantsWithoutAgreement = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== 'POST' || !GRANTS.has(c.req.path)) return next();
  const version = legalLinksOf(c.env)?.version;
  const user = c.get('user');
  if (!version || !user || coversLegalVersion(user.legalVersion, version)) return next();
  if (c.req.path.endsWith('/consent')) {
    // A clone, so Better Auth still has the body to read.
    const body = (await c.req.raw.clone().json().catch(() => null)) as { accept?: unknown } | null;
    if (body?.accept === false) return next();
  }
  return c.json(
    {
      code: 'TERMS_NOT_AGREED',
      message: 'Open Unbent and agree to its Terms and Privacy Policy before connecting an app.',
    },
    403,
  );
});
