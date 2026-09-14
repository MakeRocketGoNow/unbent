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

  /*
   * Enter keeps the caret in the emptied field, so a run of tags can be typed without
   * reaching back to the field between each. Tags come in runs; the alternative carried
   * focus to the next control after the first.
   */
  it('keeps focus in the field after Enter, ready for the next tag', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={[]} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    field.focus();
    fireEvent.change(field, { target: { value: 'Dentist' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(document.activeElement).toBe(field);
  });

  /* Tab is the one that leaves: it commits, then lets focus move on. */
  it('commits on Tab without holding focus', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={[]} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.change(field, { target: { value: 'Dentist' } });
    const prevented = !fireEvent.keyDown(field, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith(['Dentist']);
    // The commit ran, but nothing forced focus back to the field.
    expect(prevented).toBe(true);
  });

  /**
   * The field must open where the chip was, not jump elsewhere.
   *
   * jsdom does no layout, so this cannot assert pixels — it asserts the structural
   * property the smooth version depends on: the input is positioned by the wrapper at
   * every state, and only the wrapper's class changes. The first attempt swapped the
   * input between `absolute` and `static` on focus, which re-flowed it to the right of
   * the hidden hint; keeping the input's own classes constant is what prevents that.
   */
  it('does not restyle the input itself when focus arrives', () => {
    render(<TagInput tags={[]} suggestions={[]} onChange={() => {}} />);
    const field = screen.getByLabelText('Add a tag');
    const before = field.className;
    fireEvent.focus(field);
    expect(field.className).toBe(before);
  });

  it('returns to the hint once the field is empty and left', () => {
    const { container } = render(<TagInput tags={[]} suggestions={[]} onChange={() => {}} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.focus(field);
    fireEvent.blur(field);
    expect(container.querySelector('.tag-entry')!.className).toBe('tag-entry');
  });
});

describe('TagInput as an option editor', () => {
  afterEach(cleanup);

  it('takes the noun for its hint and its accessible names', () => {
    render(<TagInput label="option" tags={['GP']} suggestions={[]} onChange={() => {}} />);
    expect(screen.getByText('Add option')).toBeTruthy();
    expect(screen.getByLabelText('Add a option')).toBeTruthy();
    expect(screen.getByLabelText('Remove option GP')).toBeTruthy();
  });
});

/**
 * The suggestions, which used to be a list of buttons under the field with no way to reach
 * them from the keyboard and no announcement that they belonged to it. They are a combobox
 * now. These pin the keyboard and the semantics, and the one place the library's default
 * is overridden: leaving the field commits what was typed, never what the pointer touched.
 */
describe('TagInput suggestions', () => {
  afterEach(cleanup);
  const suggestions = ['build', 'garden', 'ideas'];

  it('is a combobox over a listbox of options, for assistive tech', () => {
    render(<TagInput tags={[]} suggestions={suggestions} onChange={() => {}} />);
    const field = screen.getByLabelText('Add a tag');
    expect(field.getAttribute('role')).toBe('combobox');
    expect(field.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(field, { target: { value: 'd' } });
    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['build', 'garden', 'ideas']);
  });

  it('moves through the suggestions with the arrow keys and files the highlighted one on Enter', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={suggestions} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'd' } });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'garden' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['garden']);
    // Emptied for the next tag, as a typed commit leaves it.
    expect(field.value).toBe('');
  });

  it('files the typed word on Enter when nothing is highlighted, suggestions or not', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={suggestions} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.change(field, { target: { value: 'd' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['d']);
  });

  it('closes the suggestions on Escape and keeps the draft', () => {
    render(<TagInput tags={[]} suggestions={suggestions} onChange={() => {}} />);
    const field = screen.getByLabelText('Add a tag') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'd' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.getAttribute('aria-expanded')).toBe('false');
    expect(field.value).toBe('d');
  });

  it('commits the typed draft on blur, not the suggestion the pointer last touched', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={suggestions} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'd' } });
    fireEvent.mouseMove(screen.getByRole('option', { name: 'build' }));
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith(['d']);
    expect(onChange).not.toHaveBeenCalledWith(['build']);
  });
});
