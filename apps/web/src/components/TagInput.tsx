import { useRef, useState } from 'react';
import { useCombobox } from 'downshift';
import { tintIndex } from '../tint.js';
import { MoveEarlierIcon, MoveLaterIcon } from './icons.js';

interface TagInputProps {
  tags: string[];
  /** Existing tag names, offered as completions. */
  suggestions: string[];
  onChange: (tags: string[]) => void;
  /**
   * What one token is called, for the hint and the accessible names: "tag" here, "option"
   * where the same editor edits a select field's choices. The control is the same either
   * way; only the noun changes.
   */
  label?: string;
  /**
   * Whether each token carries controls to nudge it one step earlier or later.
   *
   * Off by default, because for a note's tags order is nothing — they are a set, and the
   * list draws them in one fixed order however they were entered. A select field's options
   * are a sequence: they are the order the choices appear in the picker, so that editor
   * turns this on. The controls sit inside the chip, revealed on hover and focus like the
   * remove ×, so a row of options still reads as words at rest rather than as words wearing
   * three buttons each.
   */
  reorderable?: boolean;
  /**
   * Whether only a suggestion may be added.
   *
   * Off for tags, where a new word is a new tag. On where the editor holds a multi-select
   * field's value: the suggestions are the field's options, and a word that is not one of
   * them is not a value the field can hold, so it is dropped rather than turned into a
   * chip the save would refuse. The whole list is offered on a click, since there is
   * nothing to type that it does not already say.
   */
  restrict?: boolean;
}

/**
 * Token-style tag editor: a combobox over the note's existing tags.
 *
 * Commits on Enter, Tab, and comma, and on blur — committing only on Enter silently drops
 * a tag the user typed and then clicked away from, which reads as the app losing data.
 *
 * Enter keeps the caret here, in a now-empty field, rather than moving to the next control:
 * adding tags comes in runs, and a soft keyboard's action key would otherwise carry focus
 * out of the field after the first. `enterKeyHint` asks that key to read "done" rather than
 * "next", and the handler refocuses to make it so even where the hint is ignored.
 *
 * The suggestions are Downshift's `useCombobox`, not a hand-rolled list. The first version
 * was one — an input over a list of buttons — and it had no arrow keys, no Escape, and none
 * of the roles a screen reader needs to know a list is attached to a field. Downshift owns
 * the highlighted item, the arrow, Home and End keys, Escape, and the combobox, listbox and
 * option semantics, and hands back plain props to spread on our own markup, so the row's
 * chips, hint and styling are untouched. What stays ours is the commit vocabulary above,
 * which its `stateReducer` and prop-getter handlers let this component keep.
 */
export function TagInput({
  tags,
  suggestions,
  onChange,
  label = 'tag',
  reorderable = false,
  restrict = false,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  /**
   * Whether the field is being used, as opposed to merely present.
   *
   * The entry point used to be an unstyled transparent input that only announced itself
   * through a placeholder — and that placeholder was hidden as soon as the note had one
   * tag, leaving an invisible target you had to know to click. Idle, it now renders as a
   * "+ Add tag" hint beside the real chips; focused, it becomes a field.
   */
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const typed = draft.trim().toLowerCase();
  const available = suggestions
    .filter((s) => !tags.includes(s))
    // Completions appear once there is something to complete; a restricted list is the
    // whole choice, so it appears on an empty field too.
    .filter((s) => (restrict && typed === '') || (typed !== '' && s.toLowerCase().includes(typed)))
    .slice(0, restrict ? suggestions.length : 6);

  function commit(raw: string) {
    const name = raw.trim();
    setDraft('');
    if (name === '') return;
    // Restricted, a typed word means the option spelled that way, whatever its case.
    const chosen = restrict ? suggestions.find((s) => s.toLowerCase() === name.toLowerCase()) : name;
    if (chosen === undefined || tags.includes(chosen)) return;
    onChange([...tags, chosen]);
  }

  function remove(name: string) {
    onChange(tags.filter((t) => t !== name));
  }

  /**
   * Swaps a token with its neighbour one step away, the same one-step-at-a-time move the
   * field list uses. The ends have nothing to swap with and their buttons are disabled, so
   * `by` never carries an index out of range here.
   */
  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= tags.length) return;
    const next = [...tags];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  const { isOpen, highlightedIndex, getInputProps, getMenuProps, getItemProps } = useCombobox({
    items: available,
    itemToString: (item) => item ?? '',
    // The draft is ours: the field's text is this component's state, and Downshift reads it.
    inputValue: draft,
    onInputValueChange: ({ inputValue }) => setDraft(inputValue ?? ''),
    // Nothing is ever "selected" in the field: picking a suggestion commits it as a chip
    // and empties the field for the next one, so the selection is reported and dropped.
    selectedItem: null,
    onSelectedItemChange: ({ selectedItem }) => {
      if (selectedItem) commit(selectedItem);
    },
    stateReducer: (state, { type, changes }) => {
      switch (type) {
        /*
           Leaving the field commits what was typed, not what was highlighted. Downshift's
           default selects the highlighted item on blur, and the pointer highlights whatever
           it passes over — so typing "d", brushing "build" on the way to click elsewhere,
           and leaving would have filed the note under "build". The blur handler below
           commits the draft instead.
        */
        case useCombobox.stateChangeTypes.InputBlur:
          return { ...changes, selectedItem: null, inputValue: state.inputValue, isOpen: false };
        /* Escape dismisses the suggestions and keeps the draft; it does not undo typing. */
        case useCombobox.stateChangeTypes.InputKeyDownEscape:
          return { ...changes, inputValue: state.inputValue };
        /* A picked suggestion becomes a chip, and the field empties for the next one. */
        case useCombobox.stateChangeTypes.InputKeyDownEnter:
        case useCombobox.stateChangeTypes.ItemClick:
          return { ...changes, inputValue: '' };
        default:
          return changes;
      }
    },
  });

  const open = isOpen && available.length > 0;

  return (
    <div className="tag-input" onClick={() => inputRef.current?.focus()}>
      {/* Each chip's tint is the word's own — see `tintIndex` — so a tag keeps its colour everywhere. */}
      {tags.map((t, index) => (
        <span key={t} className="tag-chip" data-tint={tintIndex(t)}>
          {t}
          {/* Earlier/later before the ×, so the chip's controls read left to right as
              "move, move, remove". The ends' buttons stay rendered but disabled, the same
              as the field list's, so the pair never shifts under the pointer as a chip
              reaches an end. */}
          {reorderable && (
            <span className="tag-move-group">
              <button
                type="button"
                className="tag-move"
                aria-label={`Move ${label} ${t} earlier`}
                disabled={index === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  move(index, -1);
                }}
              >
                <MoveEarlierIcon />
              </button>
              <button
                type="button"
                className="tag-move"
                aria-label={`Move ${label} ${t} later`}
                disabled={index === tags.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  move(index, 1);
                }}
              >
                <MoveLaterIcon />
              </button>
            </span>
          )}
          <button
            type="button"
            className="tag-remove"
            aria-label={`Remove ${label} ${t}`}
            onClick={(e) => {
              e.stopPropagation();
              remove(t);
            }}
          >
            ×
          </button>
        </span>
      ))}

      <span className={active || draft !== '' ? 'tag-entry active' : 'tag-entry'}>
        {/* Sits behind the input and is hidden once it is in use, so the affordance and
            the field are the same target rather than two things to tab between. */}
        <span className="tag-add-hint" aria-hidden="true">
          <span className="tag-add-plus">+</span>
          Add {label}
        </span>
        <input
          {...getInputProps({
            ref: inputRef,
            className: 'tag-field',
            // The visible label is the hint above; this names the field for screen
            // readers, which never see it.
            'aria-label': `Add a ${label}`,
            // Not "next": Enter adds a tag and stays, so the key that does it should not
            // promise a jump to the next field.
            enterKeyHint: 'done',
            onFocus: () => setActive(true),
            onBlur: () => {
              setActive(false);
              commit(draft);
            },
            onKeyDown: (e) => {
              // A highlighted suggestion is Downshift's to select on Enter; the draft is
              // committed only when nothing is highlighted, so arrowing to "build" and
              // pressing Enter files "build", and Enter on a bare draft files the draft.
              const picking = open && highlightedIndex >= 0;
              if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
                if (draft.trim() === '' || (e.key === 'Enter' && picking)) return;
                e.preventDefault();
                commit(draft);
                // Tab is meant to leave; Enter and comma are mid-run, so hold the caret in
                // the field the commit just emptied. A soft keyboard's own action key can
                // still move focus despite preventDefault, so this puts it back.
                if (e.key !== 'Tab') inputRef.current?.focus();
              } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                // Backspace on an empty field removes the last tag, as chips usually behave.
                remove(tags[tags.length - 1]!);
              }
            },
          })}
        />

        {/* Always rendered, so the field's `aria-controls` has something to point at; the
            list only shows while there is something in it. */}
        <ul
          {...getMenuProps({ className: open ? 'tag-suggestions' : 'tag-suggestions is-closed' })}
        >
          {open &&
            available.map((s, index) => (
              <li
                key={s}
                {...getItemProps({
                  item: s,
                  index,
                  className: highlightedIndex === index ? 'is-highlighted' : undefined,
                })}
              >
                {s}
              </li>
            ))}
        </ul>
      </span>
    </div>
  );
}
