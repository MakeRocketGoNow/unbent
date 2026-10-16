import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardInset } from './useKeyboardInset.js';

/**
 * A controllable stand-in for `window.visualViewport`, which jsdom does not implement.
 *
 * jsdom has no layout either, so the hook's fixed-position probe reports where the fixed
 * containing block ends through a stubbed `getBoundingClientRect` (at `innerHeight`), as
 * in Chrome, unless `fixedBottom` says otherwise.
 */
function stubViewport(innerHeight: number, fixedBottom = innerHeight) {
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
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ top: fixedBottom, bottom: fixedBottom }) as DOMRect,
  );
  return {
    /** Simulates the keyboard opening and covering `px` of the screen. */
    cover(px: number) {
      vv.height = innerHeight - px;
      listeners.get('resize')?.forEach((fn) => fn());
    },
  };
}

describe('useKeyboardInset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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

  /**
   * Brave on Android: a toolbar at the foot of the screen hides as the keyboard opens, and
   * `innerHeight` stops matching where `bottom: 0` puts a fixed element. Measured from
   * `innerHeight`, the docked bar floated one toolbar-height above the keys.
   */
  it('measures from the fixed bottom edge, not innerHeight', () => {
    const vp = stubViewport(812, 756);
    const { result } = renderHook(() => useKeyboardInset());
    act(() => vp.cover(336));
    expect(result.current).toBe(336 - 56);
  });

  it('removes its probe on unmount', () => {
    stubViewport(812);
    const probes = () => document.querySelectorAll('[data-keyboard-inset-probe]').length;
    const before = probes();
    const { unmount } = renderHook(() => useKeyboardInset());
    expect(probes()).toBe(before + 1);
    unmount();
    expect(probes()).toBe(before);
  });

  /** Desktop browsers without the API must not break the layout that reads this. */
  it('is zero where visualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', undefined);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });
});
