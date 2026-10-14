import { describe, expect, it } from 'vitest';
import { loopbackRegistration } from './oauth-registration.js';

const publicClient = (redirect_uris: unknown, extra: Record<string, unknown> = {}) => ({
  client_name: 'Podcast Bookmarks',
  redirect_uris,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...extra,
});

describe('loopbackRegistration (MAK-218)', () => {
  it('registers a public client that only redirects to this machine as native', () => {
    for (const uri of ['http://127.0.0.1:53682/callback', 'http://localhost:53682/callback', 'http://[::1]:53682/callback']) {
      const decision = loopbackRegistration(publicClient([uri]));
      expect(decision?.kind, uri).toBe('native');
      expect(decision?.kind === 'native' && decision.body).toEqual({ ...publicClient([uri]), application_type: 'native' });
    }
  });

  it('leaves a client alone that said what it is, or never redirects here', () => {
    expect(loopbackRegistration(publicClient(['http://127.0.0.1:1/cb'], { application_type: 'native' }))).toBeNull();
    expect(loopbackRegistration(publicClient(['https://example.com/cb']))).toBeNull();
    expect(loopbackRegistration(publicClient(['com.example.app:/cb'], { application_type: 'native' }))).toBeNull();
    expect(loopbackRegistration(publicClient('not a list'))).toBeNull();
    expect(loopbackRegistration(null)).toBeNull();
  });

  it('refuses a web client with a loopback redirect, and says what to send instead', () => {
    const cases = [
      // A confidential client: holding a secret, it is not made native on a guess.
      { ...publicClient(['http://127.0.0.1:53682/callback']), token_endpoint_auth_method: 'client_secret_basic' },
      // A public client that said web.
      publicClient(['http://localhost:53682/callback'], { application_type: 'web' }),
      // One redirect here among public ones: native cannot be meant for all of them.
      publicClient(['https://example.com/cb', 'http://127.0.0.1:53682/callback']),
      // https on a loopback host is not something a web client may use either.
      publicClient(['https://127.0.0.1:53682/callback'], { application_type: 'web' }),
    ];
    for (const body of cases) {
      const decision = loopbackRegistration(body);
      expect(decision?.kind, JSON.stringify(body)).toBe('refuse');
      const message = decision?.kind === 'refuse' ? decision.message : '';
      expect(message).toContain('is a loopback redirect');
      expect(message).toContain('"application_type": "native"');
      expect(message).not.toContain('non-loopback');
    }
  });

  it('does not take a lookalike host for this machine', () => {
    expect(loopbackRegistration(publicClient(['http://localhost.example.com/cb']))).toBeNull();
    expect(loopbackRegistration(publicClient(['http://127.0.0.1.example.com/cb']))).toBeNull();
  });
});
