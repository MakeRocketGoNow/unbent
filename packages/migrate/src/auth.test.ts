import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDeviceCode, waitForToken, type DeviceCodeGrant } from './auth.js';

/**
 * The polling loop is where this can go wrong quietly: a mishandled error code turns into
 * either an infinite wait or a confusing message at the end of a long import.
 */

const BASE = 'https://notes.example';

function grant(overrides: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant {
  return {
    device_code: 'dev_1',
    user_code: 'ABCD1234',
    verification_uri: `${BASE}/device`,
    expires_in: 1800,
    // Zero so the tests do not actually sleep; the loop clamps it to 1s of fake time.
    interval: 0,
    ...overrides,
  };
}

/** Replies in order, one per poll. */
function respondWith(bodies: unknown[]): void {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
}

/** Collects what the loop would have slept, so backoff is observable without waiting. */
function recorder(): { slept: number[]; sleep: (ms: number) => Promise<void> } {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestDeviceCode', () => {
  it('asks for a code and returns the grant', async () => {
    respondWith([grant()]);
    const result = await requestDeviceCode(BASE);
    expect(result.user_code).toBe('ABCD1234');
  });
});

describe('waitForToken', () => {
  it('returns the token once approved', async () => {
    respondWith([{ access_token: 'tok_abc', token_type: 'Bearer', expires_in: 60 }]);
    await expect(waitForToken(BASE, grant(), recorder())).resolves.toBe('tok_abc');
  });

  it('keeps waiting through authorization_pending', async () => {
    respondWith([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'tok_abc', token_type: 'Bearer', expires_in: 60 },
    ]);
    await expect(waitForToken(BASE, grant(), recorder())).resolves.toBe('tok_abc');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('reports a denial in plain terms rather than the error code', async () => {
    respondWith([{ error: 'access_denied' }]);
    await expect(waitForToken(BASE, grant(), recorder())).rejects.toThrow(/denied in the browser/);
  });

  it('tells the user to start over when the code expired', async () => {
    respondWith([{ error: 'expired_token' }]);
    await expect(waitForToken(BASE, grant(), recorder())).rejects.toThrow(/expired/);
  });

  it('backs off when told to slow down, and still succeeds', async () => {
    respondWith([
      { error: 'slow_down' },
      { access_token: 'tok_abc', token_type: 'Bearer', expires_in: 60 },
    ]);
    const clock = recorder();

    await expect(waitForToken(BASE, grant({ interval: 5 }), clock)).resolves.toBe('tok_abc');

    // The increase persists into the next wait rather than applying once, which is what
    // RFC 8628 asks for and what keeps a slow server from being hammered.
    expect(clock.slept).toEqual([5000, 10000]);
  });

  it('gives up once the grant has outlived its expiry', async () => {
    respondWith([{ error: 'authorization_pending' }]);
    // Already expired: the loop must not poll forever against a code the server has
    // forgotten, which would hang the CLI with no explanation.
    await expect(waitForToken(BASE, grant({ expires_in: -1 }), recorder())).rejects.toThrow(/expired/);
  });

  it('stops when the caller aborts', async () => {
    respondWith([{ error: 'authorization_pending' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForToken(BASE, grant(), { signal: controller.signal, ...recorder() }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('surfaces an unexpected error code rather than looping on it', async () => {
    respondWith([{ error: 'invalid_client', error_description: 'Unknown client' }]);
    await expect(waitForToken(BASE, grant(), recorder())).rejects.toThrow(/Unknown client/);
  });
});
