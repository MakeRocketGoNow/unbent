import { Hono } from 'hono';
import { getAuth } from '../auth.js';
import { isTrustedPreviewOrigin } from '../lib/preview-relay.js';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

/**
 * The dev instance's half of the preview sign-in relay.
 *
 * A per-PR preview cannot sign in with Google — its hostname changes every PR, so no OAuth
 * callback can be registered against it. Instead the preview sends a signed-in-here browser
 * to this endpoint, which mints a one-time token against the dev session and redirects it
 * back to the preview, where `/preview-signin` redeems it for a session of the preview's
 * own. The premise is the shared `unbent-dev` database: a session minted here is a session
 * there. See lib/preview-relay.ts for the whole shape.
 *
 * Why this is a server endpoint that validates *and* mints *and* redirects, rather than the
 * browser fetching a token from `/one-time-token/generate` and redirecting itself: the token
 * is bearer-grade. `/one-time-token/verify` returns the full session — including the session
 * token the `bearer()` plugin accepts as `Authorization: Bearer` — so a token handed to the
 * wrong origin is a whole-account compromise, not merely a cookie set on a site that cannot
 * use it. The redirect target therefore must be checked somewhere the caller cannot bypass,
 * which is here. The browser never gets to choose an unvalidated destination for a token.
 */
export const previewRelay = new Hono<AppEnv>().get(
  '/preview-relay/start',
  // A relay is a signed-in action: only a real dev session can mint a token to hand onward.
  // An unauthenticated hit gets 401, and the SPA route in front of this sends people to
  // /login (where Google works) first, so this is reached with a session in hand.
  requireAuth,
  async (c) => {
    const returnOrigin = c.req.query('return');
    if (!returnOrigin) {
      return c.json({ error: 'Missing return origin' }, 400);
    }

    // The load-bearing check. `return` is attacker-controllable — anything can open this URL
    // with a session-carrying browser — so the token only leaves for a host proven to be one
    // of our previews. See isTrustedPreviewOrigin.
    if (!isTrustedPreviewOrigin(c.env, returnOrigin)) {
      return c.json({ error: 'Untrusted return origin' }, 400);
    }

    let token: string;
    try {
      // In-process rather than an HTTP round trip to our own /one-time-token/generate: the
      // session lives on the incoming request's cookies, which this passes straight through.
      ({ token } = await getAuth(c.env).api.generateOneTimeToken({ headers: c.req.raw.headers }));
    } catch (err) {
      // requireAuth already proved a session, so a failure here is the token store, not a
      // missing user. Surface it as a 500 rather than a redirect to a preview with no token.
      console.error('Preview relay could not mint a one-time token:', err);
      return c.json({ error: 'Could not mint a sign-in token' }, 500);
    }

    // `returnOrigin` passed isTrustedPreviewOrigin, so it is a bare https origin with no path
    // or query of its own; building the URL from it cannot be turned into an open redirect.
    const destination = new URL('/preview-signin', returnOrigin);
    destination.searchParams.set('token', token);
    return c.redirect(destination.toString());
  },
);
