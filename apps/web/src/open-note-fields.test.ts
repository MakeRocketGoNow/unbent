import { describe, it, expect, vi } from 'vitest';
import { editOpenNoteField, registerOpenNoteFieldEdit } from './open-note-fields.js';

describe('open note field edits', () => {
  it('reaches the registered note only, and no note once withdrawn', () => {
    const edit = vi.fn();
    const withdraw = registerOpenNoteFieldEdit('n1', edit);
    expect(editOpenNoteField('n2', 'f', true)).toBe(false);
    expect(editOpenNoteField('n1', 'f', true)).toBe(true);
    expect(edit).toHaveBeenCalledWith('f', true);
    withdraw();
    expect(editOpenNoteField('n1', 'f', false)).toBe(false);
  });

  it('lets a later registration outlive an earlier withdrawal', () => {
    const first = registerOpenNoteFieldEdit('n1', () => {});
    const second = vi.fn();
    registerOpenNoteFieldEdit('n2', second);
    // The first note's cleanup runs after the second registered — a route change — and
    // must not withdraw the second.
    first();
    expect(editOpenNoteField('n2', 'f', 'x')).toBe(true);
    expect(second).toHaveBeenCalledWith('f', 'x');
  });
});
