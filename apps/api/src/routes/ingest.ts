import { Hono } from 'hono';
import { posthogAssetsHost, posthogHost } from '../lib/instance.js';
import type { AppEnv } from '../types.js';

/** The prefix this router owns, stripped before the path is forwarded. */
const PREFIX = '/ingest';

/**
 * PostHog's traffic, forwarded through this Worker instead of straight from the browser.
 *
 * The reason is content blockers. A request to `posthog.com` from a page is on every
 * blocklist there is, and the reports that get dropped are not a random sample — they are
 * the ones from people running a blocker, who skew towards exactly the technical users whose
 * bug reports are worth the most. Same-origin traffic is not blocked, so `/ingest/*` is what
 * the SDK is pointed at.
 *
 * Being same-origin is also why the headers below are stripped rather than trusted. The
 * browser attaches this app's session cookie to a request to this app's own host, and
 * nothing at PostHog needs it or should ever have it. `Authorization` goes for the same
 * reason. `Host` is dropped because the value here names this Worker rather than where the
 * request ends up, and forwarding it produces a certificate mismatch upstream.
 *
 * `CF-Connecting-IP` is forwarded on as `X-Forwarded-For` deliberately: PostHog counts a
 * visitor by hashing the address at ingestion, and without it every report on this instance
 * arrives from a Cloudflare data centre and looks like one person.
 *
 * An instance with no key answers 404 rather than forwarding. There is no key to forward
 * with, so nothing useful could happen — and a proxy that relays anything to PostHog for
 * whatever project token a caller supplies is an open relay pointed at somebody else's
 * quota. Written out rather than `c.notFound()`, which does not reach the root app's
 * handler from inside a mounted router.
 */
export const ingest = new Hono<AppEnv>().all(`${PREFIX}/*`, async (c) => {
  if (!c.env.POSTHOG_KEY) return c.json({ error: 'Not found' }, 404);

  const url = new URL(c.req.url);
  const path = url.pathname.slice(PREFIX.length);
  // The SDK's own bundle comes from a different host to the one that takes events; see
  // `posthogAssetsHost`. Sending /static/* to the event host returns JSON where the browser
  // is expecting JavaScript, and the failure looks like a syntax error in someone else's code.
  const base = path.startsWith('/static/') ? posthogAssetsHost(c.env) : posthogHost(c.env);

  const headers = new Headers(c.req.raw.headers);
  headers.delete('cookie');
  headers.delete('authorization');
  headers.delete('host');
  const ip = c.req.header('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);

  return fetch(`${base}${path}${url.search}`, {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
    redirect: 'follow',
  });
});
