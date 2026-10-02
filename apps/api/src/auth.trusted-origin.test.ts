import { describe, expect, it } from 'vitest';
import { isTrustedOrigin } from './auth.js';

/**
 * The origin check the feed's WebSocket makes, against the same set sign-in trusts: a
 * deployed instance trusts exactly `APP_URL`'s origin, a local one every host the app is
 * reached on. The trailing-slash case is the one a deployed setting can carry by
 * accident and would otherwise refuse every browser.
 */
describe('isTrustedOrigin', () => {
  it('deployed: exactly the app origin, whatever the setting\'s slash', () => {
    for (const APP_URL of ['https://unbent.example', 'https://unbent.example/']) {
      expect(isTrustedOrigin({ APP_URL }, 'https://unbent.example')).toBe(true);
      expect(isTrustedOrigin({ APP_URL }, 'https://unbent.example/')).toBe(true);
      expect(isTrustedOrigin({ APP_URL }, 'http://unbent.example')).toBe(false);
      expect(isTrustedOrigin({ APP_URL }, 'https://elsewhere.example')).toBe(false);
      expect(isTrustedOrigin({ APP_URL }, 'http://localhost:5173')).toBe(false);
      expect(isTrustedOrigin({ APP_URL }, 'null')).toBe(false);
      expect(isTrustedOrigin({ APP_URL }, '')).toBe(false);
    }
  });

  it('locally: the hosts baseURLFor allows, on any port', () => {
    const env = { APP_URL: 'http://localhost:5173' };
    for (const origin of [
      'http://localhost:5173',
      'http://localhost:5219',
      'http://127.0.0.1:5173',
      'http://10.0.2.2:8787',
      'http://laptop.tail1234.ts.net:5173',
      'https://laptop.tail1234.ts.net',
      'http://laptop.ts.net',
      'http://100.64.0.1:5173',
    ]) {
      expect(isTrustedOrigin(env, origin), origin).toBe(true);
    }
    for (const origin of ['https://elsewhere.example', 'http://evil.ts.net.example', 'http://101.64.0.1', 'http://100.64.0.1.evil.example', 'http://localhost.example']) {
      expect(isTrustedOrigin(env, origin), origin).toBe(false);
    }
  });
});
