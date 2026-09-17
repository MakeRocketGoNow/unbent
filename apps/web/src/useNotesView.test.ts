import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNotesView } from './useNotesView.js';

/**
 * The view is a property of the notebook, so what these pin is the keying: turning on the
 * table for one notebook must not turn it on for the next, and a notebook opened later
 * must still find its choice.
 */
describe('useNotesView', () => {
  beforeEach(() => localStorage.clear());

  it('is the list until a notebook is made a table', () => {
    const { result } = renderHook(() => useNotesView('nb-1'));
    expect(result.current[0]).toBe('list');
    act(() => result.current[1]('table'));
    expect(result.current[0]).toBe('table');
    expect(JSON.parse(localStorage.getItem('unbent.notesView') ?? '{}')).toEqual({ 'nb-1': 'table' });
  });

  it('remembers each notebook on its own', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify({ 'nb-1': 'table' }));
    const one = renderHook(() => useNotesView('nb-1'));
    const two = renderHook(() => useNotesView('nb-2'));
    expect(one.result.current[0]).toBe('table');
    expect(two.result.current[0]).toBe('list');
  });

  it('forgets a notebook set back to the list rather than storing the default', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify({ 'nb-1': 'table' }));
    const { result } = renderHook(() => useNotesView('nb-1'));
    act(() => result.current[1]('list'));
    expect(JSON.parse(localStorage.getItem('unbent.notesView') ?? '{}')).toEqual({});
  });

  it('is the list outside a notebook, whatever is stored, and cannot be set there', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify({ 'nb-1': 'table' }));
    const { result } = renderHook(() => useNotesView(undefined));
    expect(result.current[0]).toBe('list');
    act(() => result.current[1]('table'));
    expect(JSON.parse(localStorage.getItem('unbent.notesView') ?? '{}')).toEqual({ 'nb-1': 'table' });
  });

  it('drops a stored shape it does not recognise', () => {
    localStorage.setItem('unbent.notesView', JSON.stringify(['nb-1']));
    const { result } = renderHook(() => useNotesView('nb-1'));
    expect(result.current[0]).toBe('list');
  });
});
