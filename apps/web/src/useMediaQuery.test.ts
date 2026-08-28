import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery, MOBILE_QUERY } from './useMediaQuery.js';

/**
 * jsdom ships no `matchMedia`, so every test that renders a component using this hook has
 * to provide one. This builds a controllable stub and hands back a setter that flips the
 * match and notifies subscribers, the way a real viewport change would.
 */
function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return (next: boolean) => {
    matches = next;
    listeners.forEach((fn) => fn());
  };
}

describe('useMediaQuery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the current match on the first render', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery(MOBILE_QUERY));
    // Not false-then-true: a phone must not paint the desktop layout first.
    expect(result.current).toBe(true);
  });

  it('reports no match when the query does not apply', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery(MOBILE_QUERY));
    expect(result.current).toBe(false);
  });

  it('updates when the viewport crosses the breakpoint', () => {
    const setMatches = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery(MOBILE_QUERY));
    expect(result.current).toBe(false);

    act(() => setMatches(true));
    expect(result.current).toBe(true);

    act(() => setMatches(false));
    expect(result.current).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const remove = vi.fn();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: remove,
    }));
    const { unmount } = renderHook(() => useMediaQuery(MOBILE_QUERY));
    unmount();
    expect(remove).toHaveBeenCalled();
  });
});
