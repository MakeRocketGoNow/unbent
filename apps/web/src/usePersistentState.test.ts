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
   * A bare `false` is what the hand-rolled `richEditor` toggle wrote before this hook
   * existed. That key is gone — the three-view switcher replaced it — but the encoding is
   * still what the hook writes for a boolean, so this pins that a stored bare literal
   * reads back rather than falling through to the default.
   */
  it('reads a bare boolean literal', () => {
    localStorage.setItem('unbent.splitPreview', 'false');
    const { result } = renderHook(() => usePersistentState('splitPreview', true));
    expect(result.current[0]).toBe(false);
  });

  /**
   * The note view persists only the two views you write in.
   *
   * `preview` is somewhere you go to read what you just wrote, never the state a note
   * should open in — a stored one meant every note opened onto a pane you cannot type
   * into. The parser is what enforces that, so it is pinned here: a stored `preview`
   * falls back to the editing default rather than being restored.
   */
  it('does not restore the preview view', () => {
    const parse = (raw: unknown) => (raw === 'rich' || raw === 'source' ? raw : undefined);

    localStorage.setItem('unbent.noteView', '"preview"');
    const { result } = renderHook(() => usePersistentState('noteView', 'rich', parse));
    expect(result.current[0]).toBe('rich');

    localStorage.setItem('unbent.noteView', '"source"');
    const { result: kept } = renderHook(() => usePersistentState('noteView', 'rich', parse));
    expect(kept.current[0]).toBe('source');
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
