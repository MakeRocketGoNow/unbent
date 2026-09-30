import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  offlineNow,
  reportReachable,
  reportUnreachable,
  resetConnectivity,
  subscribeConnectivity,
} from './connectivity.js';
import { OfflineError, request } from './notes-api.js';

/**
 * The two halves of "offline": what the browser says, and what the app's own requests
 * find. Airplane mode is the first; a connection that is up and carries nothing is only
 * ever the second, and the one the browser gets wrong.
 */
describe('connectivity', () => {
  beforeEach(() => resetConnectivity());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetConnectivity();
  });

  it('goes offline when a request finds no server, and back when one answers', () => {
    const changes: boolean[] = [];
    subscribeConnectivity(() => changes.push(offlineNow()));
    reportUnreachable();
    expect(offlineNow()).toBe(true);
    reportReachable();
    expect(offlineNow()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('asks the server again on its own while the browser believes it is online', async () => {
    vi.useFakeTimers();
    const health = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', health);
    reportUnreachable();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(health).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(health).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
    // A 503 is still an answer: the server is there, the database hiccuped.
    expect(offlineNow()).toBe(false);
  });

  it('waits longer between each unanswered ask', async () => {
    vi.useFakeTimers();
    const health = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', health);
    reportUnreachable();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(health).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(health).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(health).toHaveBeenCalledTimes(2);
    expect(offlineNow()).toBe(true);
  });
});

describe('request', () => {
  beforeEach(() => resetConnectivity());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetConnectivity();
  });

  it('turns a fetch that never got an answer into an OfflineError, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(request('/api/notes')).rejects.toBeInstanceOf(OfflineError);
    expect(offlineNow()).toBe(true);
  });

  it('hears the worker say it answered from its cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'X-Unbent-Served': 'cache' } })),
    );
    const res = await request('/api/notes');
    expect(res.status).toBe(200);
    expect(offlineNow()).toBe(true);
  });

  it('refuses a write at once when already offline, but still sends a read', async () => {
    reportUnreachable();
    const fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'X-Unbent-Served': 'cache' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(request('/api/notes/1', { method: 'PATCH' })).rejects.toBeInstanceOf(OfflineError);
    expect(fetch).not.toHaveBeenCalled();
    await request('/api/notes/1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a write that goes unanswered past its timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
      ),
    );
    const save = request('/api/notes/1', { method: 'PATCH', timeout: 10_000 });
    const settled = expect(save).rejects.toBeInstanceOf(OfflineError);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(offlineNow()).toBe(true);
  });

  it('passes the caller’s own abort through as it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string, init?: RequestInit) =>
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
