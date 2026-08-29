import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardInset } from './useKeyboardInset.js';

/** A controllable stand-in for `window.visualViewport`, which jsdom does not implement. */
function stubViewport(innerHeight: number) {
  const listeners = new Map<string, Set<() => void>>();
  const vv = {
    height: innerHeight,
    offsetTop: 0,
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  };
  vi.stubGlobal('visualViewport', vv);
  vi.stubGlobal('innerHeight', innerHeight);
  return {
    /** Simulates the keyboard opening and covering `px` of the screen. */
    cover(px: number) {
      vv.height = innerHeight - px;
      listeners.get('resize')?.forEach((fn) => fn());
    },
  };
}

describe('useKeyboardInset', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is zero with no keyboard open', () => {
    stubViewport(812);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });

  it('reports the covered height when the keyboard opens', () => {
    const vp = stubViewport(812);
    const { result } = renderHook(() => useKeyboardInset());
    act(() => vp.cover(336));
    expect(result.current).toBe(336);
  });

  /**
   * Rubber-band scrolling and rounding produce a few pixels of difference that are not a
   * keyboard. Without the threshold the docked bar jitters upward during an ordinary
   * scroll.
   */
  it('ignores differences too small to be a keyboard', () => {
    const vp = stubViewport(812);
    const { result } = renderHook(() => useKeyboardInset());
    act(() => vp.cover(12));
    expect(result.current).toBe(0);
  });

  it('returns to zero when the keyboard closes', () => {
    const vp = stubViewport(812);
    const { result } = renderHook(() => useKeyboardInset());
    act(() => vp.cover(336));
    act(() => vp.cover(0));
    expect(result.current).toBe(0);
  });

  /** Desktop browsers without the API must not break the layout that reads this. */
  it('is zero where visualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', undefined);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });
});
