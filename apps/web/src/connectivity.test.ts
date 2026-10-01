import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  installConnectivity,
  offlineNow,
  recheck,
  resetConnectivity,
  setReachableForTests,
} from './connectivity.js';
import { OfflineError, request } from './notes-api.js';

/**
 * Only two things decide whether the app is offline: the browser's own `navigator.onLine`,
 * and a check of the server with a timeout. Everything else — a failed request, a read the
 * worker answered from its cache, a slow save, a kept file answering while offline — only
 * asks for a check. These cases are the ones that used to decide on their own, and flicker.
 */
const health = (answer: () => Promise<Response>) =>
  vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/api/health'
      ? new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          answer().then(resolve, reject);
        })
      : Promise.reject(new TypeError('Failed to fetch')),
  );
const ok = () => Promise.resolve(new Response('{}', { status: 200 }));
const refused = () => Promise.reject(new TypeError('Failed to fetch'));
const never = () => new Promise<Response>(() => {});

beforeEach(() => resetConnectivity());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetConnectivity();
});

describe('connectivity', () => {
  it('goes offline only when the check gets no answer', async () => {
    vi.stubGlobal('fetch', health(refused));
    recheck();
    await vi.waitFor(() => expect(offlineNow()).toBe(true));
  });

  it('stays online when a request failed but the server answers the check', async () => {
    vi.stubGlobal('fetch', health(ok));
    await expect(request('/api/notes')).rejects.toBeInstanceOf(OfflineError);
    await new Promise((r) => setTimeout(r, 20));
    expect(offlineNow()).toBe(false);
  });

  it('counts a 503 as the server being there', async () => {
    vi.stubGlobal('fetch', health(() => Promise.resolve(new Response('{}', { status: 503 }))));
    recheck();
    await new Promise((r) => setTimeout(r, 20));
    expect(offlineNow()).toBe(false);
  });

  it('gives up on a check that hangs, and asks again later', async () => {
    vi.useFakeTimers();
    const fetch = health(never);
    vi.stubGlobal('fetch', fetch);
    recheck();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(offlineNow()).toBe(true);

    fetch.mockImplementation(health(ok));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(offlineNow()).toBe(false);
  });

  it('waits longer between each unanswered check', async () => {
    vi.useFakeTimers();
    const fetch = health(refused);
    vi.stubGlobal('fetch', fetch);
    recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  /*
     Airplane mode off: the browser says online a moment before the radio carries anything.
     The app stays offline until the server answers — no unlock-and-relock — and asks again
     within seconds if that first check fails.
   */
  it('lets the server, not the browser’s event, say the connection is back', async () => {
    vi.useFakeTimers();
    installConnectivity(new QueryClient());
    setReachableForTests(false);
    const fetch = health(refused);
    vi.stubGlobal('fetch', fetch);
    window.dispatchEvent(new Event('online'));
    expect(offlineNow()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(offlineNow()).toBe(true);

    fetch.mockImplementation(health(ok));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(offlineNow()).toBe(false);
  });

  /*
     Back online, what was read during the outage — maybe from the worker's cache — and what
     failed then are fetched again. What was read before it came from the server and is left
     to React Query's staleness.
   */
  it('refetches only what was read or failed while in doubt', async () => {
    const client = new QueryClient();
    installConnectivity(client);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    client.setQueryData(['before'], 'from the server');

    vi.setSystemTime(1_060_000);
    setReachableForTests(false);
    vi.setSystemTime(1_061_000);
    client.setQueryData(['during'], 'maybe from the cache');
    await client
      .fetchQuery({
        queryKey: ['failed'],
        queryFn: () => Promise.reject(new Error('offline')),
        retry: false,
        networkMode: 'offlineFirst',
      })
      .catch(() => {});

    setReachableForTests(true);
    expect(client.getQueryState(['during'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['failed'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['before'])?.isInvalidated).toBe(false);
  });
});

describe('request', () => {
  it('turns a fetch that never got an answer into an OfflineError, and asks', async () => {
    const fetch = health(refused);
    vi.stubGlobal('fetch', fetch);
    await expect(request('/api/notes')).rejects.toBeInstanceOf(OfflineError);
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/health')).toBe(true);
  });

  /*
     A file the worker kept answers with no network. While the app is offline that answer
     says nothing about the server, and must not bring the app back online on its own — it
     used to unlock the editor on a connection that carried nothing.
   */
  it('does not come back online because a kept file answered', async () => {
    setReachableForTests(false);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input) === '/api/health' ? refused() : Promise.resolve(new Response('bytes', { status: 200 })),
      ),
    );
    const res = await request('/api/notes/n1/files/receipt.png');
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(offlineNow()).toBe(true);
  });

  it('refuses a write at once when offline, but still sends a read', async () => {
    setReachableForTests(false);
    const fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'X-Unbent-Served': 'cache' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(request('/api/notes/1', { method: 'PATCH' })).rejects.toBeInstanceOf(OfflineError);
    expect(fetch).not.toHaveBeenCalled();
    await request('/api/notes/1');
    expect(fetch).toHaveBeenCalled();
  });

  /*
     A save slower than its timeout on a connection that works: the save fails, but the
     server answers the check, so the app does not claim to be offline.
   */
  it('fails a save that times out without taking the app offline when the server answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === '/api/health'
          ? ok()
          : new Promise<Response>((_, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
            ),
      ),
    );
    const save = request('/api/notes/1', { method: 'PATCH', timeout: 10_000 });
    const settled = expect(save).rejects.toBeInstanceOf(OfflineError);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    await vi.advanceTimersByTimeAsync(0);
    expect(offlineNow()).toBe(false);
  });

  it('passes the caller’s own abort through as it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
      ),
    );
    const controller = new AbortController();
    const upload = request('/api/notes/1/files', { method: 'PUT', signal: controller.signal });
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(offlineNow()).toBe(false);
  });
});
