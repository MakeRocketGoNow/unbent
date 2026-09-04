/**
 * The instance's public description of itself.
 *
 * The login screen and the Android app draw their sign-in buttons from this, so it has to
 * answer without a session and has to agree with what the auth handler accepts. The suite
 * runs with ALLOW_TEST_CREDENTIALS, so password is always among the offered methods here.
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_METHODS, isLocalMethod } from '@unbent/shared';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';

describe('GET /api/config', () => {
  it('answers without a session', async () => {
    const res = await fetch(`${BASE}/api/config`);
    expect(res.status).toBe(200);
  });

  it('lists each method once, with password while the suite can sign up', async () => {
    const res = await fetch(`${BASE}/api/config`);
    const { providers } = (await res.json()) as { providers: string[] };

    // Deliberately not checked against a fixed list. Social providers are enabled by
    // convention — `<PROVIDER>_CLIENT_ID` and its secret — so an instance may legitimately
    // report one this repository has never named, and asserting otherwise would fail the
    // moment somebody configured Discord.
    expect(new Set(providers).size).toBe(providers.length);
    expect(providers).toContain('password');
    expect(providers.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
  });

  /** Whatever else is offered, the local methods are the ones this codebase implements. */
  it('reports local methods by their documented names', async () => {
    const res = await fetch(`${BASE}/api/config`);
    const { providers } = (await res.json()) as { providers: string[] };
    const local = providers.filter(isLocalMethod);
    for (const p of local) expect(LOCAL_METHODS).toContain(p);
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

/**
 * A method that is not advertised must not be reachable either.
 *
 * The two can drift: advertising is a list this codebase builds, while the endpoints come
 * from whether a plugin was registered, and it is easy to gate one and forget the other.
 * When that happened to passkeys, `AUTH_PASSKEY=0` removed the button and left
 * /api/auth/passkey/* answering — an operator who turned them off still had them on.
 */
describe('advertisement and endpoints agree', () => {
  it('does not answer on an endpoint for a method it does not offer', async () => {
    const res = await fetch(`${BASE}/api/config`);
    const { providers } = (await res.json()) as { providers: string[] };

    if (!providers.includes('email-otp')) {
      const otp = await fetch(`${BASE}/api/auth/email-otp/send-verification-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: BASE },
        body: JSON.stringify({ email: 'probe@example.com', type: 'sign-in' }),
      });
      expect(otp.status).toBe(404);
    }

    if (!providers.includes('passkey')) {
      const pk = await fetch(`${BASE}/api/auth/passkey/generate-authenticate-options`, {
        headers: { Origin: BASE },
      });
      expect(pk.status).toBe(404);
    }
  });
});
