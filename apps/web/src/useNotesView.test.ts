import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNotesView } from './useNotesView.js';

/**
 * The view is the URL's when the URL names one, and the last one seen when it does not.
 * What these pin is that order, that the last view seen is what a silent URL is seeded
 * with — however it was seen — and that a browser still holding the short-lived
 * per-notebook shape keeps the table it had chosen.
 */
describe('useNotesView', () => {
  beforeEach(() => localStorage.clear());

  it('is the list when nothing has said otherwise', () => {
    expect(renderHook(() => useNotesView(undefined)).result.current).toBe('list');
  });

  it('takes the view the URL names, over the one remembered', () => {
    localStorage.setItem('unbent.notesView', '"table"');
    expect(renderHook(() => useNotesView('list')).result.current).toBe('list');
  });

  /* Whatever view was last on screen is the one a silent URL opens in — so following a
     bookmark, or pressing Back, and then a plain link does not change the view again. */
  it('remembers the view the URL showed, for the next URL that does not say', () => {
    renderHook(() => useNotesView('table'));
    expect(localStorage.getItem('unbent.notesView')).toBe('"table"');
    expect(renderHook(() => useNotesView(undefined)).result.current).toBe('table');

    renderHook(() => useNotesView('list'));
    expect(renderHook(() => useNotesView(undefined)).result.current).toBe('list');
  });

  it('follows the URL as it changes', () => {
    const { result, rerender } = renderHook(({ v }) => useNotesView(v), {
      initialProps: { v: 'table' as 'list' | 'table' | undefined },
    });
    expect(result.current).toBe('table');
    rerender({ v: 'list' });
    expect(result.current).toBe('list');
    rerender({ v: undefined });
    expect(result.current).toBe('list');
  });

  it('reads the earlier per-notebook shape as the table it had chosen', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify({ 'nb-1': 'table' }));
    expect(renderHook(() => useNotesView(undefined)).result.current).toBe('table');
    localStorage.setItem('unbent.notesView', JSON.stringify({}));
    expect(renderHook(() => useNotesView(undefined)).result.current).toBe('list');
  });

  it('drops a stored value it does not recognise', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify(['nb-1']));
    expect(renderHook(() => useNotesView(undefined)).result.current).toBe('list');
  });
});
