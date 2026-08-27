import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistentState, clamp } from './usePersistentState.js';

describe('usePersistentState', () => {
  beforeEach(() => localStorage.clear());

  it('falls back when the key is absent', () => {
    const { result } = renderHook(() => usePersistentState('missing', 'default'));
    expect(result.current[0]).toBe('default');
  });

  it('reads an existing value', () => {
    localStorage.setItem('unbent.width', '320');
    const { result } = renderHook(() => usePersistentState('width', 200));
    expect(result.current[0]).toBe(320);
  });

  it('writes under the unbent namespace', () => {
    const { result } = renderHook(() => usePersistentState('width', 200));
    act(() => result.current[1](340));
    expect(localStorage.getItem('unbent.width')).toBe('340');
    expect(result.current[0]).toBe(340);
  });

  it('accepts an updater, like useState', () => {
    const { result } = renderHook(() => usePersistentState('showPreview', true));
    act(() => result.current[1]((p) => !p));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('unbent.showPreview')).toBe('false');
  });

  /**
   * A half-written or hand-edited value must not take the app down. Storage is read
   * during the initial render, so a throw here is a white screen rather than a bad width.
   */
  it('falls back rather than throwing on malformed JSON', () => {
    localStorage.setItem('unbent.width', '{not json');
    const { result } = renderHook(() => usePersistentState('width', 200));
    expect(result.current[0]).toBe(200);
  });

  /**
   * `richEditor` predates this hook and was written as the bare string "false" by hand.
   * That is accidentally valid JSON, which is the only reason the key did not need
   * migrating. Pinned so that a later change to the encoding cannot silently reset
   * everyone's editor mode without failing here first.
   */
  it('reads the pre-hook richEditor value', () => {
    localStorage.setItem('unbent.richEditor', 'false');
    const { result } = renderHook(() => usePersistentState('richEditor', true));
    expect(result.current[0]).toBe(false);
  });

  it('rejects a value the parser refuses', () => {
    localStorage.setItem('unbent.width', '9999');
    const { result } = renderHook(() =>
      usePersistentState('width', 304, (raw) =>
        typeof raw === 'number' && raw >= 200 && raw <= 480 ? raw : undefined,
      ),
    );
    expect(result.current[0]).toBe(304);
  });
});

describe('clamp', () => {
  it('holds a value inside its limits', () => {
    expect(clamp(300, 200, 480)).toBe(300);
    expect(clamp(120, 200, 480)).toBe(200);
    expect(clamp(900, 200, 480)).toBe(480);
  });
});
