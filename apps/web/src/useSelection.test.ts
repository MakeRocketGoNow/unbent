import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSelection } from './useSelection.js';

/**
 * The selection's rules, which are the part a screenshot cannot check: what a range runs
 * from, what a change of scope does, and that rows the list no longer holds are not
 * counted — since an action reaches exactly what `ids` says.
 */
const rows = ['a', 'b', 'c', 'd', 'e'];

function mount(initial: { rows: string[]; anchor?: string; key: string }) {
  return renderHook(
    (props: { rows: string[]; anchor?: string; key: string }) =>
      useSelection(props.rows, { anchor: props.anchor, resetKey: props.key }),
    { initialProps: initial },
  );
}

describe('useSelection', () => {
  it('toggles rows and reports them in the list’s order', () => {
    const { result } = mount({ rows, key: 'k' });
    expect(result.current.active).toBe(false);
    act(() => result.current.pick('c'));
    act(() => result.current.pick('a'));
    expect(result.current.ids).toEqual(['a', 'c']);
    expect(result.current.active).toBe(true);
    act(() => result.current.pick('c'));
    expect(result.current.ids).toEqual(['a']);
    expect(result.current.has('c')).toBe(false);
  });

  it('ranges from the last row picked alone, and adds to what is selected', () => {
    const { result } = mount({ rows, key: 'k' });
    act(() => result.current.pick('b'));
    act(() => result.current.pick('d', { range: true }));
    expect(result.current.ids).toEqual(['b', 'c', 'd']);
    // The anchor stays on b: a second range runs the other way from the same row.
    act(() => result.current.pick('a', { range: true }));
    expect(result.current.ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('brings the open note along on the first pick of another row', () => {
    const { result } = mount({ rows, anchor: 'b', key: 'k' });
    act(() => result.current.pick('d'));
    expect(result.current.ids).toEqual(['b', 'd']);
    // Only the first: the open note is not re-added once the selection is under way.
    act(() => result.current.pick('b'));
    act(() => result.current.pick('e'));
    expect(result.current.ids).toEqual(['d', 'e']);
  });

  it('just selects the open note when it is the row picked', () => {
    const { result } = mount({ rows, anchor: 'b', key: 'k' });
    act(() => result.current.pick('b'));
    expect(result.current.ids).toEqual(['b']);
  });

  it('leaves out an open note that is not on screen', () => {
    const { result } = mount({ rows, anchor: 'gone', key: 'k' });
    act(() => result.current.pick('d'));
    expect(result.current.ids).toEqual(['d']);
  });

  it('ranges from the open note before anything has been picked', () => {
    const { result } = mount({ rows, anchor: 'd', key: 'k' });
    act(() => result.current.pick('b', { range: true }));
    expect(result.current.ids).toEqual(['b', 'c', 'd']);
  });

  it('selects the one row when the anchor is not on screen', () => {
    const { result } = mount({ rows, anchor: 'gone', key: 'k' });
    act(() => result.current.pick('c', { range: true }));
    expect(result.current.ids).toEqual(['c']);
  });

  it('drops the selection when the scope changes', () => {
    const { result, rerender } = mount({ rows, key: 'k' });
    act(() => result.current.pick('a'));
    rerender({ rows, key: 'other' });
    expect(result.current.ids).toEqual([]);
    expect(result.current.active).toBe(false);
  });

  it('counts only rows the list still holds', () => {
    const { result, rerender } = mount({ rows, key: 'k' });
    act(() => result.current.pick('a'));
    act(() => result.current.pick('b'));
    rerender({ rows: ['b', 'c'], key: 'k' });
    expect(result.current.ids).toEqual(['b']);
  });

  it('selects every loaded row, and clears', () => {
    const { result } = mount({ rows, key: 'k' });
    act(() => result.current.selectAll());
    expect(result.current.ids).toEqual(rows);
    act(() => result.current.clear());
    expect(result.current.ids).toEqual([]);
  });
});
