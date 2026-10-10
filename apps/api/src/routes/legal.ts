import { Hono } from 'hono';
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
 * holding an older config — open in a tab across a deploy that moved `LEGAL_VERSION` —
 * would otherwise record agreement to documents it never showed, so it is told 409 and
 * reloads the config, which shows the new ones. The time is the server's, never the
 * client's: it is the record of when.
 *
 * The answer carries a fresh session cookie. The session is served from a signed cookie
 * for up to five minutes (`cookieCache` in `auth.ts`), and that cookie still says the
 * account has not agreed; without replacing it, the app would ask again the moment it
 * re-read the session. Passing the request through Better Auth's own `get-session` with the
 * cache bypassed reads the row just written and sets the cookie from it — the same thing
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

  await c.env.DB.prepare('UPDATE user SET legalVersion = ?, legalAgreedAt = ? WHERE id = ?')
    .bind(current, new Date().toISOString(), c.get('userId')!)
    .run();

  const refreshed = await getAuth(c.env).handler(
    new Request(new URL('/api/auth/get-session?disableCookieCache=true', c.req.url), {
      headers: c.req.raw.headers,
    }),
  );
  for (const cookie of refreshed.headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
  return c.json({ version: current });
});
