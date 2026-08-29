import { useRef, useState } from 'react';

interface TagInputProps {
  tags: string[];
  /** Existing tag names, offered as completions. */
  suggestions: string[];
  onChange: (tags: string[]) => void;
}

/**
 * Token-style tag editor.
 *
 * Commits on Enter, Tab, and comma, and on blur — committing only on Enter silently drops
 * a tag the user typed and then clicked away from, which reads as the app losing data.
 */
export function TagInput({ tags, suggestions, onChange }: TagInputProps) {
  const [draft, setDraft] = useState('');
  /**
   * Whether the field is being used, as opposed to merely present.
   *
   * The entry point used to be an unstyled transparent input that only announced itself
   * through a placeholder — and that placeholder was hidden as soon as the note had one
   * tag, leaving an invisible target you had to know to click. Idle, it now renders as a
   * dashed "+ Add tag" chip beside the real ones; focused, it becomes a field.
   */
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const available = suggestions
    .filter((s) => !tags.includes(s))
    .filter((s) => draft.trim() !== '' && s.toLowerCase().includes(draft.trim().toLowerCase()))
    .slice(0, 6);

  function commit(raw: string) {
    const name = raw.trim();
    setDraft('');
    if (name === '' || tags.includes(name)) return;
    onChange([...tags, name]);
  }

  function remove(name: string) {
    onChange(tags.filter((t) => t !== name));
  }

  return (
    <div className="tag-input" onClick={() => inputRef.current?.focus()}>
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          {t}
          <button
            type="button"
            className="tag-remove"
            aria-label={`Remove tag ${t}`}
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
          Add tag
        </span>
        <input
          ref={inputRef}
          className="tag-field"
          value={draft}
          // The visible label is the hint above; this names the field for screen readers,
          // which never see it.
          aria-label="Add a tag"
          onFocus={() => setActive(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setActive(false);
            commit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
              if (draft.trim() === '') return;
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
              // Backspace on an empty field removes the last tag, as chips usually behave.
              remove(tags[tags.length - 1]!);
            }
          }}
        />

        {available.length > 0 && (
          <ul className="tag-suggestions">
            {available.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  // onMouseDown, not onClick: blur fires first and would commit the draft
                  // before a click ever lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(s);
                  }}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  );
}
