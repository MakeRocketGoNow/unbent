import { describe, expect, it, vi, afterEach } from 'vitest';
import { wellKnown } from './well-known.js';
import type { Env } from '../types.js';

/** Only the fields this route reads; the bindings are irrelevant here. */
function env(vars: Record<string, string | undefined>): Env {
  return { APP_URL: 'https://example.com', ...vars } as unknown as Env;
}

const STATEMENTS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.example.notes',
      sha256_cert_fingerprints: ['AA:BB'],
    },
  },
];

/**
 * The Digital Asset Links document used to be a static file, which meant every fork served
 * unbent.app's package and signing keys on its own domain, and its own app got nothing.
 * Now it is whatever the deployment says it is — a secret, like the operator's name — and
 * an instance that has said nothing serves nothing.
 */
describe('/.well-known/assetlinks.json', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers 404 on an instance that has not published one', async () => {
    const res = await wellKnown.request('/.well-known/assetlinks.json', {}, env({}));
    expect(res.status).toBe(404);
  });

  it('treats a blank value as unset', async () => {
    const res = await wellKnown.request(
      '/.well-known/assetlinks.json',
      {},
      env({ ANDROID_ASSET_LINKS: '  ' }),
    );
    expect(res.status).toBe(404);
  });

  it('serves the configured statements as JSON', async () => {
    const res = await wellKnown.request(
      '/.well-known/assetlinks.json',
      {},
      env({ ANDROID_ASSET_LINKS: JSON.stringify(STATEMENTS, null, 2) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(STATEMENTS);
  });

  /**
   * Google's verifier and Credential Manager both parse the document strictly, and a
   * misconfigured value would otherwise surface as "passkeys stopped being offered" on a
   * phone, far from the secret that caused it. Saying so in the log and the response is
   * the only place the operator will look.
   */
  it('refuses to serve a value that is not JSON, and says why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await wellKnown.request(
      '/.well-known/assetlinks.json',
      {},
      env({ ANDROID_ASSET_LINKS: '{not json' }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'ANDROID_ASSET_LINKS is not valid JSON' });
    expect(error).toHaveBeenCalledOnce();
  });

  /* The document is a list of statements; anything else is a paste of the wrong thing. */
  it('refuses JSON that is not an array of statements', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await wellKnown.request(
      '/.well-known/assetlinks.json',
      {},
      env({ ANDROID_ASSET_LINKS: '{"relation": []}' }),
    );
    expect(res.status).toBe(500);
  });
});
