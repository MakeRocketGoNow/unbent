import type { FieldDef, FieldValue } from '@unbent/shared';
import { tintIndex } from '../tint.js';

interface FieldCellInputProps {
  def: FieldDef;
  /** The value held, or null for none. */
  value: FieldValue | null | undefined;
  readOnly?: boolean;
  onChange: (value: FieldValue | null) => void;
  /** For a labelled row in the property list; the table names the control instead. */
  id?: string | undefined;
  /** An accessible name where no `<label>` points at the control — a table cell. */
  label?: string | undefined;
}

/**
 * The two field controls that are a single choice: a checkbox, and a select.
 *
 * Shared by the note's property list and the table's cells, because both draw them the
 * same way and the select has a rule worth keeping in one place: a value that is no
 * longer among the options stays selectable rather than being blanked. The note said it,
 * and the option list changing is not the note's edit. The stylesheet draws a chosen
 * option as a chip in the option's own tint — the tint the tag editor gives the word —
 * and an unchosen one as "Empty", which is Notion's word for it.
 *
 * Null for every other type: those are typed into, and a cell is not the place for that
 * yet — the note is.
 */
export function FieldCellInput({
  def,
  value,
  readOnly = false,
  onChange,
  id,
  label,
}: FieldCellInputProps) {
  if (def.type === 'checkbox') {
    return (
      <input
        id={id}
        className="note-field-check"
        type="checkbox"
        disabled={readOnly}
        checked={value === true || value === 'true'}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (def.type === 'select') {
    const text = value === null || value === undefined ? '' : String(value);
    const stale = text !== '' && !def.options.includes(text);
    return (
      <select
        id={id}
        className="note-field-input"
        disabled={readOnly}
        data-filled={text !== '' || undefined}
        data-tint={text !== '' ? tintIndex(text) : undefined}
        value={text}
        aria-label={label}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">Empty</option>
        {def.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {stale && <option value={text}>{text} (no longer an option)</option>}
      </select>
    );
  }
  return null;
}
