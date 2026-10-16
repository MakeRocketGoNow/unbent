import { useEffect, useRef, useState } from 'react';
import { useCombobox } from 'downshift';
import { MAX_FIELD_NAME_LENGTH, sameName } from '@unbent/shared';
import { tintIndex } from '../tint.js';
import { ChipPencilIcon, MoveEarlierIcon, MoveLaterIcon } from './icons.js';
import { filledStyle } from './filled.js';

interface Renaming {
  from: string;
  value: string;
  width: number;
}

interface TagInputProps {
  tags: string[];
  /**
   * Tags just added for the person rather than by them — an Auto-fill press — ringed for a
   * moment so they can be told from the ones that were there, in order from `at`.
   */
  fresh?: { at: number; names: readonly string[] } | undefined;
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
   * Turns each chip's word into a button that renames it in place.
   *
   * For a select field's options, where a rename is not a removal and an addition: the
   * notes holding the old name move to the new one, which the remove-then-add this editor
   * otherwise offers cannot do. The word is the target, with a pencil beside it surfacing
   * on hover like the chip's other controls, and pressing it swaps the word for a field of
   * the same size in the same place — the chip does not move or reflow. Enter or leaving
   * the field renames; Escape puts the word back.
   *
   * Resolves `true` once the rename is applied, and the chip shows the new name until the
   * list it is given catches up, so it does not flick back to the old one while the save
   * and the refetch are in flight. `false` — refused, or held for a confirm — shows the
   * old name at once, since nothing has changed yet.
   */
  onRename?: ((from: string, to: string) => Promise<boolean>) | undefined;
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
  /**
   * Whether a name in another case is the token that exists. On for tags, which the
   * store finds without case (MAK-127): "receipts" typed beside Receipts files Receipts,
   * and a tag the note has is not added twice. The fold is the store's (`sameName`, ASCII
   * only), so a name it keeps apart is kept apart here. Off where the editor holds a
   * select field's options, which are compared exactly.
   */
  caseless?: boolean;
  /**
   * Shown, not edited — a note in the trash, or any note while offline. The chips stay as
   * words; the × on each and the "+ Add" entry go, since a control that is drawn but
   * cannot be used is the thing this app keeps removing. Nothing at all to show reads as
   * "No tags" rather than as an empty row, which would look like a layout fault.
   */
  readOnly?: boolean;
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
  caseless = true,
  readOnly = false,
  fresh,
  onRename,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  /**
   * The chip whose word is a field just now, what has been typed into it, and how wide
   * the word and its pencil were — the field's floor, so the chip never narrows as the
   * name is cleared and retyped and the row after it never reflows. Only a longer name
   * than the old one widens it.
   */
  const [renaming, setRenamingState] = useState<Renaming | null>(null);
  // Mirrored in a ref, cleared the moment a rename ends: Enter unmounts the field, a
  // browser may blur it on the way out, and that blur's handler still closes over the
  // render where the field was open. The ref is what tells it the rename is over.
  const renamingRef = useRef(renaming);
  function setRenaming(next: Renaming | null) {
    renamingRef.current = next;
    setRenamingState(next);
  }
  /** A rename sent and applied, drawn over the old name until `tags` stops holding it. */
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null);
  /** The chip whose word gets focus back once it is drawn, after a rename by keyboard. */
  const focusAfter = useRef<string | null>(null);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    setRenamed((r) => (r && !tags.includes(r.from) ? null : r));
  }, [tags]);
  // After every commit that could have drawn it: the chip a cancel puts back is drawn on
  // the next render, the one a rename makes only once the new list arrives.
  useEffect(() => {
    const name = focusAfter.current;
    const button = name === null ? undefined : labelRefs.current.get(name);
    if (button) {
      focusAfter.current = null;
      button.focus();
    }
  });

  // Focused with the old name selected, so typing replaces it and an arrow key keeps it to
  // correct. Not `autoFocus` with a select on focus: React's autoFocus runs before the
  // focus listener can, and the caret landed at the end of the old name.
  const renameRef = useRef<HTMLInputElement>(null);
  const renamingFrom = renaming?.from;
  useEffect(() => {
    if (renamingFrom === undefined) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renamingFrom]);

  function startRename(from: string, width: number) {
    setRenaming({ from, value: from, width });
  }

  /**
   * Ends a rename. Empty or unchanged is a cancel, not a refusal: the word goes back as it
   * was. Called from Enter, Escape and blur alike, and only the first of them acts.
   */
  function finishRename(save: boolean, refocus: boolean) {
    const current = renamingRef.current;
    if (!current) return;
    const { from } = current;
    const to = current.value.trim();
    setRenaming(null);
    if (!save || to === '' || to === from || !onRename) {
      if (refocus) focusAfter.current = from;
      return;
    }
    setRenamed({ from, to });
    void onRename(from, to).then((applied) => {
      if (!applied) {
        // Refused, or held for a confirm — which takes the focus itself. A chip already
        // named `to` (a merge) must not be focused here: it would pull focus off the
        // question about it.
        setRenamed(null);
        return;
      }
      if (!refocus) return;
      // The list may have caught up already; if not, the effect focuses it when it does.
      const button = labelRefs.current.get(to);
      if (button) button.focus();
      else focusAfter.current = to;
    });
  }
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

  const same = caseless ? sameName : (a: string, b: string) => a === b;
  const typed = draft.trim().toLowerCase();
  const available = suggestions
    .filter((s) => !tags.some((t) => same(t, s)))
    // Completions appear once there is something to complete; a restricted list is the
    // whole choice, so it appears on an empty field too.
    .filter((s) => (restrict && typed === '') || (typed !== '' && s.toLowerCase().includes(typed)))
    .slice(0, restrict ? suggestions.length : 6);

  function commit(raw: string) {
    const name = raw.trim();
    setDraft('');
    if (name === '') return;
    // Restricted, a typed word means the option spelled that way, whatever its case. A
    // tag typed in another case is the tag that exists, so the chip shows its spelling
    // now rather than changing under the person once the save comes back.
    const chosen = restrict
      ? suggestions.find((s) => s.toLowerCase() === name.toLowerCase())
      : (suggestions.find((s) => same(s, name)) ?? name);
    if (chosen === undefined || tags.some((t) => same(t, chosen))) return;
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

  /** A chip: its own tint, and a ring for a moment if it is one of `fresh`. */
  const chipProps = (t: string) => {
    const k = fresh?.names.findIndex((n) => sameName(n, t)) ?? -1;
    const at = fresh && k >= 0 ? fresh.at + k : undefined;
    return {
      className: at === undefined ? 'tag-chip' : 'tag-chip fresh',
      'data-tint': tintIndex(t),
      style: filledStyle(at),
    };
  };

  if (readOnly) {
    return (
      <div className="tag-input read-only">
        {tags.length === 0 ? (
          <span className="tag-none">No {label}s</span>
        ) : (
          tags.map((t) => (
            <span key={t} {...chipProps(t)}>
              {t}
            </span>
          ))
        )}
      </div>
    );
  }

  return (
    <div className="tag-input" onClick={() => inputRef.current?.focus()}>
      {/* Each chip's tint is the word's own — see `tintIndex` — so a tag keeps its colour everywhere. */}
      {tags.map((t, index) => {
        const chip = chipProps(t);
        return (
          <span key={t} {...chip} className={renaming?.from === t ? `${chip.className} renaming` : chip.className}>
            {onRename && renaming?.from === t ? (
              <input
                className="tag-rename-field"
                aria-label={`Rename ${label} ${t}`}
                value={renaming.value}
                maxLength={MAX_FIELD_NAME_LENGTH}
                // Measured by its text where the browser can (`field-sizing` in the
                // stylesheet); `size` is the fallback, about a character a column.
                size={Math.max(renaming.value.length, 1)}
                enterKeyHint="done"
                ref={renameRef}
                onClick={(e) => e.stopPropagation()}
                style={{ minWidth: renaming.width }}
                onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    finishRename(true, true);
                  } else if (e.key === 'Escape') {
                    // Ours, not the sheet's or the page's: Escape here undoes the typing.
                    e.preventDefault();
                    e.stopPropagation();
                    finishRename(false, true);
                  }
                }}
                onBlur={() => finishRename(true, false)}
              />
            ) : onRename ? (
              <button
                type="button"
                className="tag-label"
                ref={(el) => {
                  if (el) labelRefs.current.set(t, el);
                  else labelRefs.current.delete(t);
                }}
                aria-label={`Rename ${label} ${t}`}
                data-tip="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(t, e.currentTarget.getBoundingClientRect().width);
                }}
              >
                {renamed?.from === t ? renamed.to : t}
                <span className="tag-label-pencil" aria-hidden="true">
                  <ChipPencilIcon />
                </span>
              </button>
            ) : (
              t
            )}
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
                  data-tip="Move earlier"
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
                  data-tip="Move later"
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
        );
      })}

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
              }
              // Backspace on an empty field does nothing to the tags. It used to remove the
              // last one, as many chip inputs do, but clearing a typo means pressing it a few
              // times too many, and each extra press then took a tag off the note — saved at
              // once, with nothing to say it happened. The same field edits a notebook
              // field's options, where it deleted those. A chip's own × is the way to remove.
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
