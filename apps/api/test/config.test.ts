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
});
