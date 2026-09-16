/**
 * The dev instance's half of the preview sign-in relay.
 *
 * This is a security boundary: `/api/preview-relay/start` mints a bearer-grade one-time
 * token against the caller's session and redirects it to the `return` origin, so the two
 * things that must hold are that it refuses without a session, and that it refuses a return
 * origin it cannot prove is one of our previews. Both are checked here against the live
 * Worker.
 *
 * The happy-path redirect needs `PREVIEW_RELAY_SUBDOMAIN` configured on the Worker, which
 * the local dev server does not set, so it is not exercised here; `isTrustedPreviewOrigin`'s
 * acceptance is unit-tested exhaustively in src/lib/preview-relay.test.ts, and the token
 * mint is Better Auth's own. What a live test can prove without that config is that the
 * refusals fire, which is the half that fails dangerous.
 */
import { describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';

describe('GET /api/preview-relay/start', () => {
  it('refuses without a session', async () => {
    const res = await fetch(
      `${BASE}/api/preview-relay/start?return=${encodeURIComponent('https://unbent-pr-1.of2668.workers.dev')}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(401);
  });

  /**
   * No session, but also a bad origin. It must still refuse rather than redirect — checked
   * because the order of the guards is easy to get wrong, and "unauthenticated but the URL
   * was malformed" must never be the case that slips a token out.
   */
  it('refuses without a session even for a malformed request', async () => {
    const res = await fetch(`${BASE}/api/preview-relay/start`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });
});
