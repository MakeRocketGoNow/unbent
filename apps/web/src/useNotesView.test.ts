import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNotesView } from './useNotesView.js';

/**
 * The view comes from the URL when it names one and from storage when it does not. What
 * these pin is that order, that the stored half survives a reload, and that a browser
 * still holding the short-lived per-notebook shape keeps the table it had chosen.
 */
describe('useNotesView', () => {
  beforeEach(() => localStorage.clear());

  it('is the list until the table is chosen, and remembers the choice', () => {
    const first = renderHook(() => useNotesView(undefined));
    expect(first.result.current[0]).toBe('list');
    act(() => first.result.current[1]('table'));
    expect(first.result.current[0]).toBe('table');
    expect(localStorage.getItem('unbent.notesView')).toBe('"table"');

    // A second mount — another notebook, a reload — finds the same view.
    const second = renderHook(() => useNotesView(undefined));
    expect(second.result.current[0]).toBe('table');
  });

  /* A link that names a view means it, whatever this device usually shows — and opening
     one is not choosing: the remembered view is untouched. */
  it('lets the URL outrank the remembered view without changing it', () => {
    localStorage.setItem('unbent.notesView', '"table"');
    expect(renderHook(() => useNotesView('list')).result.current[0]).toBe('list');
    expect(localStorage.getItem('unbent.notesView')).toBe('"table"');

    localStorage.setItem('unbent.notesView', '"list"');
    expect(renderHook(() => useNotesView('table')).result.current[0]).toBe('table');
  });

  it('goes back to the list when asked', () => {
    localStorage.setItem('unbent.notesView', '"table"');
    const { result } = renderHook(() => useNotesView(undefined));
    act(() => result.current[1]('list'));
    expect(result.current[0]).toBe('list');
    expect(localStorage.getItem('unbent.notesView')).toBe('"list"');
  });

  it('reads the earlier per-notebook shape as the table it had chosen', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify({ 'nb-1': 'table' }));
    expect(renderHook(() => useNotesView(undefined)).result.current[0]).toBe('table');
    localStorage.setItem('unbent.notesView', JSON.stringify({}));
    expect(renderHook(() => useNotesView(undefined)).result.current[0]).toBe('list');
  });

  it('drops a stored value it does not recognise', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify(['nb-1']));
    expect(renderHook(() => useNotesView(undefined)).result.current[0]).toBe('list');
  });
});
