import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { keys } from './queries.js';
import { PAST_INSTANT_RETRY_MS, usePlanRefresh } from './use-plan.js';

/**
 * The plan read again at an instant it named, and again later while the answer still
 * names one this device has passed: a device clock ahead of the server's finds the trial
 * still running at its end, and nothing else would ask again.
 */
describe('usePlanRefresh', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads a plan that still names a passed instant again, with a growing wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    const trial = { state: 'trial', until: now - 1000, readOnlyAt: now - 1000, source: null, storageGb: 10, subscription: null };
    // The server, a little behind: still the trial, ending a second ago by this clock.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(trial), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.config(), { providers: ['password'], billing: { environment: 'test' } });
    client.setQueryData(keys.plan(), trial);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(() => usePlanRefresh(), { wrapper });
    await act(async () => {});
    const reads = () => invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(keys.plan())).length;
    expect(reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_INSTANT_RETRY_MS + 100);
    });
    expect(reads()).toBe(2);
    // The next wait is twice as long: nothing at the first wait's length again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_INSTANT_RETRY_MS + 100);
    });
    expect(reads()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_INSTANT_RETRY_MS);
    });
    expect(reads()).toBe(3);
  });

  it('keeps setting the next wait when a read fails, so a tab left in the background is not stranded on the trial', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    const trial = { state: 'trial', until: now - 1000, readOnlyAt: now - 1000, source: null, storageGb: 10, subscription: null };
    // Every read fails: a failed read changes the error's date and not the answer's,
    // and the retry's wait was set only from the answer's.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"down"}', { status: 503, headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.config(), { providers: ['password'], billing: { environment: 'test' } });
    client.setQueryData(keys.plan(), trial);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(() => usePlanRefresh(), { wrapper });
    await act(async () => {});
    const reads = () => invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(keys.plan())).length;
    expect(reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_INSTANT_RETRY_MS + 100);
    });
    expect(reads()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * PAST_INSTANT_RETRY_MS + 100);
    });
    expect(reads()).toBe(3);
  });

  it('asks nothing more once the plan names no instant this device has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    const free = { state: 'free', until: now - 1000, readOnlyAt: null, source: null, storageGb: 1, subscription: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(free), { status: 200 })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.config(), { providers: ['password'], billing: { environment: 'test' } });
    client.setQueryData(keys.plan(), free);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(() => usePlanRefresh(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * PAST_INSTANT_RETRY_MS);
    });
    expect(invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(keys.plan()))).toHaveLength(0);
  });
});
