import { useEffect, useRef, useState } from 'react';
import {
  EmojiPicker,
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
} from 'frimousse';
import { Button } from './Button';
import { NotebookGlyph } from './icons.js';

interface EmojiFieldProps {
  /** The notebook's emoji, or `null` for the book. */
  emoji: string | null;
  /** The notebook's name, for the trigger's accessible label. */
  name: string;
  disabled?: boolean;
  /** An emoji picked, or `null` for "Remove". */
  onChange: (emoji: string | null) => void;
}

/*
   The list's parts, as frimousse lets them be replaced. Its defaults are unstyled divs and
   buttons; these only put this app's class on each so `styles.css` can draw them, and keep
   frimousse's own props (the sizing it measures by, the grid roles, the handlers) intact.
*/
function CategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div className="emoji-category" {...props}>
      {category.label}
    </div>
  );
}

function EmojiRow({ children, ...props }: EmojiPickerListRowProps) {
  return (
    <div className="emoji-row" {...props}>
      {children}
    </div>
  );
}

function EmojiCell({ emoji, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button type="button" className="emoji-cell" {...props}>
      {emoji.emoji}
    </button>
  );
}

/**
 * A notebook's emoji, chosen from a picker that opens under it.
 *
 * The trigger is the glyph itself (the emoji, or the book when there is none) in a
 * bordered square the height of the name field beside it. It is what the notebook looks
 * like everywhere else, so the control and its result are the same picture, and the
 * picker opens from where that picture is rather than somewhere else on the page.
 *
 * A picker rather than a one-character text box: a phone's keyboard has an emoji tab, but
 * on a Mac the way in is ⌃⌘Space, and a field that only works if you know a shortcut is
 * an affordance nobody finds. frimousse draws the searchable grid; it is unstyled, so it
 * wears this app's tokens rather than bringing a look of its own. Its emoji data comes
 * from a CDN the first time the picker opens and is cached in the browser after that.
 *
 * Inline and absolutely positioned, dismissed by Escape or a press outside: the same
 * choices, for the same reasons, as `OverflowMenu`. Picking saves at once, like the field
 * type select below it: it is one choice, not text being typed, so there is nothing to
 * debounce.
 */
export function EmojiField({ emoji, name, disabled = false, onChange }: EmojiFieldProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // pointerdown, not click, as in `OverflowMenu`: a press outside closes the picker
    // without also activating whatever it landed on.
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  /** Closes the picker and puts focus back on the square it opened from. */
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const pick = (next: string | null) => {
    close();
    if (next !== emoji) onChange(next);
  };

  return (
    <div
      className="emoji-field"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="emoji-trigger"
        disabled={disabled}
        aria-label={emoji ? `Change the emoji for ${name}` : `Choose an emoji for ${name}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <NotebookGlyph emoji={emoji} />
      </button>

      {open && (
        <div className="emoji-panel" role="dialog" aria-label="Choose an emoji">
          <EmojiPicker.Root
            className="emoji-picker"
            columns={8}
            onEmojiSelect={({ emoji: picked }) => pick(picked)}
          >
            {/* Focused on open, so typing a word finds the emoji straight away, the way
                every picker people know behaves. */}
            <EmojiPicker.Search
              className="search-field emoji-search"
              placeholder="Search emoji"
              aria-label="Search emoji"
              autoFocus
            />
            <EmojiPicker.Viewport className="emoji-viewport">
              <EmojiPicker.Loading className="emoji-status muted small">
                Loading emoji…
              </EmojiPicker.Loading>
              <EmojiPicker.Empty className="emoji-status muted small">
                No emoji match that.
              </EmojiPicker.Empty>
              <EmojiPicker.List
                className="emoji-list"
                components={{ CategoryHeader, Row: EmojiRow, Emoji: EmojiCell }}
              />
            </EmojiPicker.Viewport>
            {/* The foot names the emoji under the pointer or the arrow keys, since a small
                picture alone does not always say which one it is; and, when the notebook
                has an emoji, offers the way back to the book. */}
            <div className="emoji-foot">
              <EmojiPicker.ActiveEmoji>
                {({ emoji: active }) => (
                  <span className="emoji-active muted small">
                    {active ? `${active.emoji} ${active.label}` : 'Pick an emoji'}
                  </span>
                )}
              </EmojiPicker.ActiveEmoji>
              {emoji && (
                <Button variant="quiet" size="small" onClick={() => pick(null)}>
                  Remove
                </Button>
              )}
            </div>
          </EmojiPicker.Root>
        </div>
      )}
    </div>
  );
}
