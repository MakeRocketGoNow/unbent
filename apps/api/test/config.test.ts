/**
 * The instance's public description of itself.
 *
 * The login screen and the Android app draw their sign-in buttons from this, so it has to
 * answer without a session and has to agree with what the auth handler accepts. The suite
 * runs with ALLOW_TEST_CREDENTIALS, so password is always among the offered methods here.
 */
import { describe, expect, it } from 'vitest';
import { AUTH_PROVIDERS } from '@unbent/shared';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';

describe('GET /api/config', () => {
  it('answers without a session', async () => {
    const res = await fetch(`${BASE}/api/config`);
    expect(res.status).toBe(200);
  });

  it('lists known providers once each, with password while the suite can sign up', async () => {
    const res = await fetch(`${BASE}/api/config`);
    const { providers } = (await res.json()) as { providers: string[] };

    for (const p of providers) expect(AUTH_PROVIDERS).toContain(p);
    expect(new Set(providers).size).toBe(providers.length);
    expect(providers).toContain('password');
  });

  /**
   * Passkeys need nothing registered anywhere — the other half of WebAuthn is the browser
   * and the user's own device — so unlike every other method there is no configuration
   * that could switch them off, and no instance that should be missing them.
   */
  it('always offers passkeys, which need nothing configured', async () => {
    const res = await fetch(`${BASE}/api/config`);
    const { providers } = (await res.json()) as { providers: string[] };
    expect(providers).toContain('passkey');
  });

  /**
   * Codes by email are what let a deployment drop its OAuth providers without becoming
   * unreachable to anyone lacking those accounts, so the gate matters: offered where a
   * code can actually arrive, absent where it would vanish into a log. Locally that means
   * present, because `sendEmail` prints the code to the console when Resend is unset.
   */
  it('offers email codes locally, where the console stands in for a mail provider', async () => {
    const res = await fetch(`${BASE}/api/config`);
    const { providers } = (await res.json()) as { providers: string[] };
    expect(providers).toContain('email-otp');
  });

  /**
   * The endpoints have to agree with the advertisement. A method listed here but not
   * mounted is the failure this endpoint exists to prevent — it is what the hardcoded
   * Google button used to do, offering a provider with no credentials behind it.
   */
  it('mounts the endpoints for every method it advertises', async () => {
    const res = await fetch(`${BASE}/api/config`);
    const { providers } = (await res.json()) as { providers: string[] };

    if (providers.includes('email-otp')) {
      const otp = await fetch(`${BASE}/api/auth/email-otp/send-verification-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: BASE },
        body: JSON.stringify({ email: 'config-probe@example.com', type: 'sign-in' }),
      });
      expect(otp.status).not.toBe(404);
    }

    if (providers.includes('passkey')) {
      const pk = await fetch(`${BASE}/api/auth/passkey/generate-authenticate-options`, {
        headers: { Origin: BASE },
      });
      expect(pk.status).not.toBe(404);
    }
  });
});
