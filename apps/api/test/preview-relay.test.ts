/**
 * The dev instance's half of the preview sign-in relay.
 *
 * The relay is off unless the instance is configured as a relay source
 * (`PREVIEW_RELAY_SUBDOMAIN` set — the dev deploy alone). The local dev server the live
 * suite runs against sets neither relay variable, so what a live test proves here is the
 * gate: an unconfigured instance answers 404 on the endpoint, so it does not exist on
 * production rather than existing and refusing every request.
 *
 * The behaviour once configured — the session requirement, the trusted-origin check, the
 * mint and redirect — is covered where it can be exercised deterministically:
 * `isTrustedPreviewOrigin` and `previewRelayEnabled` are unit-tested in
 * src/lib/preview-relay.test.ts, and the full mint-and-redeem path was verified end to end
 * against a Worker with the subdomain set.
 */
import { describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';

describe('GET /api/preview-relay/start', () => {
  /**
   * 404, not 401, on an instance that is not a relay source — the gate runs before the
   * session check, so the endpoint gives no sign it exists or wants a session.
   */
  it('does not exist where the relay is not configured', async () => {
    const res = await fetch(
      `${BASE}/api/preview-relay/start?return=${encodeURIComponent('https://unbent-pr-1.of2668.workers.dev')}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(404);
  });

  it('404s a malformed request too, rather than disclosing the endpoint', async () => {
    const res = await fetch(`${BASE}/api/preview-relay/start`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });
});
