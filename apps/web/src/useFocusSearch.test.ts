import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useFocusSearch } from './useFocusSearch.js';

/**
 * The Cmd/Ctrl+F search shortcut.
 *
 * What is pinned: that the combo focuses the field and selects its text from elsewhere on
 * the page and preventDefaults the browser's find; that a second press, once the field
 * already has focus, is let through so find-in-page can open; and that a bare F or the
 * wrong chord is left alone.
 */
function setup() {
  const input = document.createElement('input');
  document.body.appendChild(input);
  const ref = { current: input };
  // Spy without replacing: the real focus() must run so activeElement updates, which is
  // what the "already focused" branch reads.
  const focus = vi.spyOn(input, 'focus');
  const select = vi.spyOn(input, 'select');
  renderHook(() => useFocusSearch(ref));
  return { input, ref, focus, select };
}

/** A keydown for `key` with the given init, returning whether the default was prevented. */
function press(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('useFocusSearch', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('focuses the field and selects its text on Cmd+F, and takes the key from the browser', () => {
    const { focus, select } = setup();
    const prevented = press('f', { metaKey: true });
    expect(focus).toHaveBeenCalled();
    expect(select).toHaveBeenCalled();
    expect(prevented).toBe(true);
  });

  it('works with Ctrl+F for non-Mac', () => {
    const { focus } = setup();
    expect(press('f', { ctrlKey: true })).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  it('lets a second press through once the field has focus, so find-in-page can open', () => {
    const { input } = setup();
    // First press lands focus in the field.
    expect(press('f', { metaKey: true })).toBe(true);
    expect(document.activeElement).toBe(input);
    // Second press, field already focused: the browser's find is what this one is for.
    expect(press('f', { metaKey: true })).toBe(false);
  });

  it('ignores a bare f and the wrong chord', () => {
    const { focus } = setup();
    press('f');
    press('f', { metaKey: true, shiftKey: true });
    press('f', { metaKey: true, altKey: true });
    expect(focus).not.toHaveBeenCalled();
  });
});
