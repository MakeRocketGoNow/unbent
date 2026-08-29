import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TagInput } from './TagInput.js';

/**
 * The affordance for adding a tag.
 *
 * The entry point was a transparent borderless input whose only hint was a placeholder —
 * and that placeholder was suppressed as soon as the note had one tag, so adding a second
 * meant knowing to click an invisible strip of the row. These pin the parts of the fix
 * that are not CSS: that the hint is always rendered, that it yields to the field in use,
 * and that the field is still reachable by name.
 */
describe('TagInput add affordance', () => {
  afterEach(cleanup);

  it('offers a visible hint even when the note already has tags', () => {
    render(<TagInput tags={['Optometrist']} suggestions={[]} onChange={() => {}} />);
    // The old build showed nothing here once a tag existed.
    expect(screen.getByText('Add tag')).toBeTruthy();
  });

  it('names the field for assistive tech, which never sees the hint', () => {
    render(<TagInput tags={[]} suggestions={[]} onChange={() => {}} />);
    expect(screen.getByLabelText('Add a tag')).toBeTruthy();
  });

  it('marks the entry active while the field is in use', () => {
    const { container } = render(<TagInput tags={[]} suggestions={[]} onChange={() => {}} />);
    const entry = container.querySelector('.tag-entry')!;
    expect(entry.className).toBe('tag-entry');

    fireEvent.focus(screen.getByLabelText('Add a tag'));
    // `.active` is what swaps the dashed chip for a real field.
    expect(entry.className).toContain('active');
  });

  /**
   * Typing must not leave the dashed chip sitting over the text. The chip is suppressed
   * by focus *or* a non-empty draft — the second half matters because the field can hold
   * text while focus is momentarily elsewhere, as it is during a suggestion click.
   */
  it('hides the hint while a draft is present, not only while focused', () => {
    const { container } = render(<TagInput tags={[]} suggestions={[]} onChange={() => {}} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.change(field, { target: { value: 'Dent' } });
    expect(container.querySelector('.tag-entry')!.className).toContain('active');
  });

  /** Blur commits what was typed, so the row returns to offering the next tag. */
  it('commits on blur and returns to the hint', () => {
    const onChange = vi.fn();
    const { container } = render(<TagInput tags={[]} suggestions={[]} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'Dentist' } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith(['Dentist']);
    expect(container.querySelector('.tag-entry')!.className).toBe('tag-entry');
  });

  it('still commits a tag on Enter', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={[]} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.change(field, { target: { value: 'Dentist' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['Dentist']);
  });

  it('returns to the hint once the field is empty and left', () => {
    const { container } = render(<TagInput tags={[]} suggestions={[]} onChange={() => {}} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.focus(field);
    fireEvent.blur(field);
    expect(container.querySelector('.tag-entry')!.className).toBe('tag-entry');
  });
});
