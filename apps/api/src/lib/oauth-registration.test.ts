import { describe, expect, it } from 'vitest';
import { loopbackRegistration, registrationSummary, withoutEmptyMetadata } from './oauth-registration.js';

const publicClient = (redirect_uris: unknown, extra: Record<string, unknown> = {}) => ({
  client_name: 'Acme Assistant',
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

describe('withoutEmptyMetadata (MAK-224)', () => {
  it('takes out the empty values a client wrote instead of leaving fields out', () => {
    const body = {
      client_name: 'Acme Assistant',
      redirect_uris: ['https://relay.example.com/r/abc'],
      token_endpoint_auth_method: 'client_secret_basic',
      client_uri: null,
      logo_uri: '',
      contacts: [],
      scope: null,
    };
    expect(withoutEmptyMetadata(body)).toEqual({
      client_name: 'Acme Assistant',
      redirect_uris: ['https://relay.example.com/r/abc'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
  });

  it('leaves a body with nothing empty, and anything that is not a body, alone', () => {
    expect(withoutEmptyMetadata(publicClient(['https://example.com/cb']))).toBeNull();
    expect(withoutEmptyMetadata(null)).toBeNull();
    expect(withoutEmptyMetadata('text')).toBeNull();
    expect(withoutEmptyMetadata([null])).toBeNull();
  });

  it('passes non-empty values through as sent, for the provider to judge', () => {
    // A false, a zero and a list holding an empty string are values, not absences.
    const body = { require_pkce: false, client_secret_expires_at: 0, contacts: [''], jwks: {}, scope: null };
    expect(withoutEmptyMetadata(body)).toEqual({ require_pkce: false, client_secret_expires_at: 0, contacts: [''], jwks: {} });
  });
});

describe('registrationSummary (MAK-224)', () => {
  it('names redirect hosts, never the paths a relay keeps per-user ids in', () => {
    const summary = registrationSummary(
      publicClient(['https://relay.example.com/r/user-1234', 'https://relay.example.com/r/user-5678', 'not a uri']),
    );
    expect(summary).toMatchObject({
      client_name: 'Acme Assistant',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_hosts: ['relay.example.com', '(not a URI)'],
      redirect_count: 3,
    });
    expect(JSON.stringify(summary)).not.toContain('user-1234');
  });

  it('bounds what it copies, since anyone can send the request', () => {
    const summary = registrationSummary({
      client_name: 'x'.repeat(500),
      scope: 'y'.repeat(5000),
      grant_types: Array.from({ length: 100 }, () => 'z'.repeat(500)),
      token_endpoint_auth_method: { nested: 'w'.repeat(500) },
      ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 1])),
    });
    expect(JSON.stringify(summary).length).toBeLessThan(5000);
    expect(summary.token_endpoint_auth_method).toBe('object');
  });

  it('says what it was given when it was not a body', () => {
    expect(registrationSummary(undefined)).toEqual({ body: 'undefined' });
  });
});
