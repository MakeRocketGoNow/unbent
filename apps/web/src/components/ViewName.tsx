import { useEffect, useId, useRef, useState } from 'react';
import { MAX_TAG_LENGTH, viewNameSchema } from '@unbent/shared';
import { Button } from './Button';

interface ViewNameFieldProps {
  /** What the field starts with: nothing for a new view, the name for a rename. */
  initial?: string;
  /** The field's accessible name: "View name", "New name for Business 2026". */
  label: string;
  /** The commit button's word: "Save", or "Rename". */
  commitLabel: string;
  /**
   * Saves the name, which `viewNameSchema` has already passed. A rejection's message is
   * shown under the field, the server's "already has a view with that name" above all,
   * and the field stays as typed so the name can be fixed rather than typed again.
   */
  onCommit: (name: string) => Promise<void>;
  onCancel: () => void;
  /** Extra class on the wrapper: where it sits decides how wide it may be. */
  className?: string;
  /** The input's own class, for a field drawn in a heading's type (`NoteListHead`). */
  inputClassName?: string;
}

/**
 * The inline field a view is named in: saving one, saving an edited one as new, renaming
 * one from the list's heading or the notebook's settings.
 *
 * Inline, in the row the button that opened it was in, rather than a dialog: the name is
 * one short line, and what is being named (the chips, the list under them) is the thing
 * a dialog would cover. Enter saves and Escape leaves, as the label editor's row does;
 * the Save and Cancel beside the field are the same two for a pointer and a thumb, since
 * a field that saved itself on blur would save a half-typed name for a reader who only
 * meant to scroll. A name already taken in the notebook comes back from the server as a
 * short line under the field, not a snackbar: it is about this field, and the field is
 * where the eye is.
 *
 * Fenced, unlike the label editor's bare `.label-field`, which only reads inside a row
 * that is already fenced: here it sits among chips, where a borderless input would be
 * text with a caret in it.
 */
export function ViewNameField({
  initial = '',
  label,
  commitLabel,
  onCommit,
  onCancel,
  className,
  inputClassName,
}: ViewNameFieldProps) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // Focus on arrival with the caret at the end: a rename is usually a correction there.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  async function commit() {
    if (busy) return;
    const parsed = viewNameSchema.safeParse(value);
    if (!parsed.success) {
      setError(value.trim() === '' ? 'Give the view a name.' : `A name can be at most ${MAX_TAG_LENGTH} characters.`);
      return;
    }
    // An unchanged rename is a cancel: there is nothing to send.
    if (parsed.data === initial.trim() && initial !== '') {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCommit(parsed.data);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      ref.current?.focus();
    }
  }

  return (
    <div className={['view-name', className].filter(Boolean).join(' ')}>
      <div className="view-name-row">
        <input
          ref={ref}
          className={['view-name-field', inputClassName].filter(Boolean).join(' ')}
          value={value}
          placeholder="View name"
          aria-label={label}
          aria-invalid={error !== null || undefined}
          aria-describedby={error ? errorId : undefined}
          maxLength={MAX_TAG_LENGTH}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <Button variant="secondary" size="small" disabled={busy} onClick={() => void commit()}>
          {busy ? 'Saving…' : commitLabel}
        </Button>
        <Button variant="quiet" size="small" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <p id={errorId} className="bad small view-name-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
