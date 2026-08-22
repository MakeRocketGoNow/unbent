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

      <span className="tag-entry">
        <input
          ref={inputRef}
          className="tag-field"
          value={draft}
          placeholder={tags.length === 0 ? 'Add tags…' : ''}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
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
