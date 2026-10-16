import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ingest } from './ingest.js';
import type { Env } from '../types.js';

/** Only the fields this route reads; the bindings are irrelevant here. */
function env(vars: Record<string, string | undefined>): Env {
  return { APP_URL: 'https://example.com', ...vars } as unknown as Env;
}

const KEYED = env({ POSTHOG_KEY: 'phc_x' });

/**
 * The proxy exists so that a content blocker does not drop error reports, which means it
 * carries the browser's own request to a third party. What is pinned here is everything
 * that must not go with it (the session cookie above all) and the one thing that must:
 * the client address PostHog counts a visitor by.
 */
describe('ingest', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(new Response('ok')));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const forwardedTo = () => fetchMock.mock.calls[0]?.[0] as string;
  const forwardedHeaders = () => (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers;

  /* Not an open relay: without a key of our own there is nothing to forward with, and
     relaying whatever token a caller supplies spends somebody else's quota. */
  it('answers 404 on an instance with no PostHog key', async () => {
    const res = await ingest.request('/ingest/e/', { method: 'POST', body: '{}' }, env({}));

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards an event, query string and all', async () => {
    await ingest.request('/ingest/e/?ip=1&_=2', { method: 'POST', body: '{}' }, KEYED);

    expect(forwardedTo()).toBe('https://us.i.posthog.com/e/?ip=1&_=2');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
  });

  /* The bundle and the event endpoint are different hosts; sending /static/* to the wrong
     one returns JSON where the browser expects JavaScript. */
  it('serves the SDK bundle from the assets host', async () => {
    await ingest.request('/ingest/static/array.js', {}, KEYED);

    expect(forwardedTo()).toBe('https://us-assets.i.posthog.com/static/array.js');
  });

  it('strips the session cookie and authorization on the way out', async () => {
    await ingest.request(
      '/ingest/e/',
      {
        method: 'POST',
        headers: {
          cookie: 'better-auth.session_token=secret',
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: '{}',
      },
      KEYED,
    );

    const headers = forwardedHeaders();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    // Still a proxy, not a rewrite: everything else the SDK sent goes through.
    expect(headers.get('content-type')).toBe('application/json');
  });

  /* Without this every report arrives from a Cloudflare data centre and PostHog counts the
     whole instance as one visitor. */
  it('passes the client address on as X-Forwarded-For', async () => {
    await ingest.request(
      '/ingest/e/',
      { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.9' }, body: '{}' },
      KEYED,
    );

    expect(forwardedHeaders().get('x-forwarded-for')).toBe('203.0.113.9');
  });

  it('follows the instance to another region', async () => {
    const eu = env({ POSTHOG_KEY: 'phc_x', POSTHOG_HOST: 'https://eu.i.posthog.com' });
    await ingest.request('/ingest/e/', { method: 'POST', body: '{}' }, eu);

    expect(forwardedTo()).toBe('https://eu.i.posthog.com/e/');
  });
});
