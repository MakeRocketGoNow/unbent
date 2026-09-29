import { describe, it, expect } from 'vitest';
import { withAppUrl } from './app-url.js';
import type { RawEnv } from '../types.js';

function raw(vars: Record<string, unknown>): RawEnv {
  return { DB: {}, BLOBS: {}, USER_STORE: {}, BETTER_AUTH_SECRET: 's', ...vars } as unknown as RawEnv;
}

const request = (url: string) => new Request(url);

describe('withAppUrl', () => {
  it('leaves a configured env exactly as it was', () => {
    const env = raw({ APP_URL: 'https://notes.example.com' });
    expect(withAppUrl(env, request('https://other.example.net/api/health'))).toBe(env);
  });

  /**
   * Whitespace or an empty string is how a dashboard "clear the value" or a stray `--var
   * APP_URL:` ends up looking, and neither is an address anyone meant.
   */
  it('treats an empty or blank APP_URL as unset', () => {
    const blank = withAppUrl(raw({ APP_URL: '  ' }), request('https://a.example/x'));
    expect(blank.APP_URL).toBe('https://a.example');
    const empty = withAppUrl(raw({ APP_URL: '' }), request('https://a.example/x'));
    expect(empty.APP_URL).toBe('https://a.example');
  });

  it('derives the bare origin: scheme and host, no path, no trailing slash', () => {
    const env = withAppUrl(raw({}), request('https://unbent-api.someone.workers.dev/api/notes?x=1'));
    expect(env.APP_URL).toBe('https://unbent-api.someone.workers.dev');
  });

  it('keeps a non-default port in the origin', () => {
    const env = withAppUrl(raw({}), request('http://127.0.0.1:8790/api/health'));
    expect(env.APP_URL).toBe('http://127.0.0.1:8790');
  });

  /** The bindings are what the routes actually need; a view that dropped one would 500. */
  it('carries every binding through to the view', () => {
    const base = raw({ DB: { marker: 'db' }, RESEND_API_KEY: 'k' });
    const env = withAppUrl(base, request('https://b.example/'));
    expect(env.DB).toBe(base.DB);
    expect(env.BLOBS).toBe(base.BLOBS);
    expect(env.RESEND_API_KEY).toBe('k');
  });

  /**
   * `getAuth` memoizes on the env object's identity, so two requests on one origin must
   * see one object — and two origins must not, or the second would inherit the first's
   * base URL and refuse its own sign-ins.
   */
  it('returns the same view for the same origin and a different one per origin', () => {
    const base = raw({});
    const first = withAppUrl(base, request('https://c.example/one'));
    const again = withAppUrl(base, request('https://c.example/two'));
    const other = withAppUrl(base, request('https://d.example/one'));
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(other.APP_URL).toBe('https://d.example');
  });
});
