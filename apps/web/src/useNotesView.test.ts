import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNotesView } from './useNotesView.js';

/**
 * The view is one choice that holds across notebooks. What these pin is that it is stored
 * as itself, survives a reload, and that a browser still holding the short-lived
 * per-notebook shape keeps the table it had chosen.
 */
describe('useNotesView', () => {
  beforeEach(() => localStorage.clear());

  it('is the list until the table is chosen, and remembers the choice', () => {
    const first = renderHook(() => useNotesView());
    expect(first.result.current[0]).toBe('list');
    act(() => first.result.current[1]('table'));
    expect(first.result.current[0]).toBe('table');
    expect(localStorage.getItem('unbent.notesView')).toBe('"table"');

    // A second mount — another notebook, a reload — finds the same view.
    const second = renderHook(() => useNotesView());
    expect(second.result.current[0]).toBe('table');
  });

  it('goes back to the list when asked', () => {
    localStorage.setItem('unbent.notesView', '"table"');
    const { result } = renderHook(() => useNotesView());
    act(() => result.current[1]('list'));
    expect(result.current[0]).toBe('list');
    expect(localStorage.getItem('unbent.notesView')).toBe('"list"');
  });

  it('reads the earlier per-notebook shape as the table it had chosen', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify({ 'nb-1': 'table' }));
    expect(renderHook(() => useNotesView()).result.current[0]).toBe('table');
    localStorage.setItem('unbent.notesView', JSON.stringify({}));
    expect(renderHook(() => useNotesView()).result.current[0]).toBe('list');
  });

  it('drops a stored value it does not recognise', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify(['nb-1']));
    expect(renderHook(() => useNotesView()).result.current[0]).toBe('list');
  });
});
