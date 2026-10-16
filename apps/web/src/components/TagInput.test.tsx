import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

  /*
   * Clearing a typo overshoots. Backspace in an empty field used to take the last tag off
   * the note, one per extra press; the field now stays empty and the tags stay put.
   */
  it('leaves the tags alone when Backspace is pressed in the empty field', () => {
    const onChange = vi.fn();
    render(<TagInput tags={['Halloween', 'Dentist']} suggestions={[]} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.focus(field);
    for (let i = 0; i < 3; i++) fireEvent.keyDown(field, { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Halloween')).toBeTruthy();
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
 * Reordering, which only a select field's options ask for — a note's tags are a set and
 * are left alone. These pin that the controls appear only when opted in, that each nudge
 * hands back the whole list in its new order (the shape the field editor PATCHes), and
 * that the ends cannot move off either edge.
 */
describe('TagInput reordering', () => {
  afterEach(cleanup);

  it('offers no move controls unless asked, so a tag row stays a set', () => {
    render(<TagInput label="tag" tags={['a', 'b']} suggestions={[]} onChange={() => {}} />);
    expect(screen.queryByLabelText('Move tag a later')).toBeNull();
  });

  it('gives each option an earlier and a later control when reorderable', () => {
    render(
      <TagInput label="option" tags={['Want', 'Neat']} suggestions={[]} reorderable onChange={() => {}} />,
    );
    expect(screen.getByLabelText('Move option Want later')).toBeTruthy();
    expect(screen.getByLabelText('Move option Neat earlier')).toBeTruthy();
  });

  it('moves an option later by swapping it with its neighbour', () => {
    const onChange = vi.fn();
    render(
      <TagInput label="option" tags={['Want', 'Neat']} suggestions={[]} reorderable onChange={onChange} />,
    );
    fireEvent.click(screen.getByLabelText('Move option Want later'));
    expect(onChange).toHaveBeenCalledWith(['Neat', 'Want']);
  });

  it('moves an option earlier by swapping it with its neighbour', () => {
    const onChange = vi.fn();
    render(
      <TagInput
        label="option"
        tags={['Want', 'Researching', 'Neat']}
        suggestions={[]}
        reorderable
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Move option Neat earlier'));
    expect(onChange).toHaveBeenCalledWith(['Want', 'Neat', 'Researching']);
  });

  /* The ends have nothing to swap with; their buttons are disabled rather than absent. */
  it('disables the first option’s earlier control and the last one’s later control', () => {
    render(
      <TagInput label="option" tags={['Want', 'Neat']} suggestions={[]} reorderable onChange={() => {}} />,
    );
    expect((screen.getByLabelText('Move option Want earlier') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Move option Neat later') as HTMLButtonElement).disabled).toBe(true);
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

/*
 * Restricted to its suggestions, the editor holds a multi-select field's value: the
 * suggestions are the options, and a word that is not one of them is not a value.
 */
describe('TagInput restricted to its suggestions', () => {
  afterEach(cleanup);
  const options = ['PC', 'PS5', 'Switch'];

  it('offers every remaining option on a click, before anything is typed', () => {
    render(<TagInput tags={['PS5']} suggestions={options} onChange={() => {}} label="option" restrict />);
    const field = screen.getByLabelText('Add a option');
    fireEvent.click(field);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['PC', 'Switch']);
  });

  it('files a typed option whatever its case, and drops a word that is no option', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={options} onChange={onChange} label="option" restrict />);
    const field = screen.getByLabelText('Add a option') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'switch' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['Switch']);

    fireEvent.change(field, { target: { value: 'Xbox' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('');
  });

  it('still lets free text through when not restricted', () => {
    const onChange = vi.fn();
    render(<TagInput tags={[]} suggestions={options} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.change(field, { target: { value: 'Xbox' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['Xbox']);
  });
});

/*
 * A tag is found without case (MAK-127), so a name typed in another case is the tag that
 * exists: the chip says so at once, and a tag the note already has is not added twice.
 * Folded as the store folds, ASCII only, so a name it keeps apart is kept apart here.
 */
describe('TagInput and the case of a tag', () => {
  afterEach(cleanup);

  it('files a typed tag in the spelling that exists, once', () => {
    const onChange = vi.fn();
    render(<TagInput tags={['Garden']} suggestions={['Receipts', 'Garden', 'Café']} onChange={onChange} />);
    const field = screen.getByLabelText('Add a tag');
    fireEvent.change(field, { target: { value: 'receipts' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['Garden', 'Receipts']);

    fireEvent.change(field, { target: { value: 'GARDEN' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.change(field, { target: { value: 'CAFÉ' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['Garden', 'CAFÉ']);
  });

  it('leaves a field’s options exact, as they always were', () => {
    const onChange = vi.fn();
    render(<TagInput tags={['Small']} suggestions={[]} onChange={onChange} label="option" caseless={false} />);
    const field = screen.getByLabelText('Add a option');
    fireEvent.change(field, { target: { value: 'small' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['Small', 'small']);
  });
});

/**
 * Read-only is the trash and every note while offline. Tags there are shown as words, with
 * nothing on the row that would take a click and then go nowhere.
 */
describe('TagInput read-only', () => {
  afterEach(cleanup);

  it('shows the tags without anything to change them with', () => {
    render(<TagInput tags={['travel', 'receipts']} suggestions={[]} onChange={vi.fn()} readOnly />);
    expect(screen.getByText('travel')).toBeTruthy();
    expect(screen.getByText('receipts')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/Add tag/)).toBeNull();
  });

  it('says there are none rather than drawing an empty row', () => {
    render(<TagInput tags={[]} suggestions={[]} onChange={vi.fn()} readOnly />);
    expect(screen.getByText('No tags')).toBeTruthy();
  });
});

/**
 * Renaming a chip in place (`onRename`), the select option editor's. The word is the
 * button; pressing it swaps in a field holding the name, Enter or leaving renames, and
 * Escape puts the word back. Nothing that is not a change is reported as one.
 */
describe('TagInput rename', () => {
  afterEach(cleanup);

  function open(onRename = vi.fn().mockResolvedValue(true)) {
    render(<TagInput tags={['Food', 'Travel']} suggestions={[]} onChange={vi.fn()} label="option" caseless={false} onRename={onRename} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename option Food' }));
    return { onRename, input: screen.getByRole('textbox', { name: 'Rename option Food' }) as HTMLInputElement };
  }

  it('offers no rename where none is asked for', () => {
    render(<TagInput tags={['Food']} suggestions={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Rename/ })).toBeNull();
  });

  it('opens a field holding the name, and renames on Enter', async () => {
    const { onRename, input } = open();
    expect(input.value).toBe('Food');
    fireEvent.change(input, { target: { value: ' Meals ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Food', 'Meals');
    // Shown under the new name while the list it was given still has the old one.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename option Food' }).textContent).toBe('Meals'));
  });

  it('renames once when Enter is followed by the blur of the field going away', () => {
    const { onRename, input } = open();
    fireEvent.change(input, { target: { value: 'Meals' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('renames on leaving the field, as the add field commits on blur', () => {
    const { onRename, input } = open();
    fireEvent.change(input, { target: { value: 'Meals' } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith('Food', 'Meals');
  });

  it('puts the word back on Escape without renaming', () => {
    const { onRename, input } = open();
    fireEvent.change(input, { target: { value: 'Meals' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename option Food' }).textContent).toBe('Food');
  });

  it('treats an empty or unchanged name as a cancel', () => {
    const { onRename, input } = open();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Rename option Food' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename option Food' }), { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('shows the old name again when the rename is not applied', async () => {
    const { input } = open(vi.fn().mockResolvedValue(false));
    fireEvent.change(input, { target: { value: 'Travel' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename option Food' }).textContent).toBe('Food'));
  });
});
