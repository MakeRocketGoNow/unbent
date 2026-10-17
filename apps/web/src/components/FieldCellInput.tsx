import { isRatingField, type FieldDef, type FieldValue } from '@unbent/shared';
import { RatingInput } from './RatingInput.js';
import { TagInput } from './TagInput.js';

interface FieldCellInputProps {
  def: FieldDef;
  /** The value held, or null for none. */
  value: FieldValue | null | undefined;
  readOnly?: boolean;
  onChange: (value: FieldValue | null) => void;
  /** For a labelled row in the property list; the table names the control instead. */
  id?: string | undefined;
  /** An accessible name where no `<label>` points at the control: a table cell. */
  label?: string | undefined;
}

/**
 * The field controls that are a choice rather than typing: a checkbox, a select, a
 * multi-select, and a rating.
 *
 * Shared by the note's property list and the table's cells, because both draw them the
 * same way and the select has a rule worth keeping in one place: a value that is no
 * longer among the options stays selectable rather than being blanked. The note said it,
 * and the option list changing is not the note's edit. The stylesheet draws a chosen
 * option as a chip in the colour the field's settings gave the option (`optionColors`,
 * the neutral grey for one it no longer lists), and an unchosen one as "Empty", which
 * is Notion's word for it.
 *
 * A multi-select is the tag editor over the field's options: chips for what is chosen,
 * and a restricted entry that offers the rest. The same rule about retired options
 * holds: a chip the list no longer offers stays, removable, until the note lets go of
 * it. Read-only, it is the chips alone.
 *
 * A rating belongs here for the same reason: it is picked, not typed. It is the one
 * control whose shape depends on its definition rather than only its type (a `number`
 * with a scale), which is what `isRatingField` is for.
 *
 * Null for every other type: those are typed into, and a cell is not the place for that
 * yet: the note is.
 */
export function FieldCellInput({
  def,
  value,
  readOnly = false,
  onChange,
  id,
  label,
}: FieldCellInputProps) {
  if (isRatingField(def) && def.scale) {
    const n = typeof value === 'number' ? value : Number(value);
    return (
      <RatingInput
        id={id}
        scale={def.scale}
        value={value === null || value === undefined || !Number.isFinite(n) ? null : n}
        readOnly={readOnly}
        onChange={onChange}
        label={label}
      />
    );
  }
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
        data-color={text !== '' ? def.optionColors?.[text] : undefined}
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
  if (def.type === 'multiselect') {
    const chosen = Array.isArray(value)
      ? value
      : value === null || value === undefined || value === ''
        ? []
        : [String(value)];
    if (readOnly) {
      return (
        <span id={id} className="note-field-multi tag-input" aria-label={label}>
          {chosen.length === 0 && <span className="note-field-empty">Empty</span>}
          {chosen.map((o) => (
            <span key={o} className="tag-chip" data-color={def.optionColors?.[o]}>
              {o}
            </span>
          ))}
        </span>
      );
    }
    return (
      <div id={id} className="note-field-multi" role="group" aria-label={label ?? def.name}>
        <TagInput
          label="option"
          caseless={false}
          tags={chosen}
          suggestions={def.options}
          restrict
          colorOf={(o) => def.optionColors?.[o] ?? null}
          onChange={(next) => onChange(next.length === 0 ? null : next)}
        />
      </div>
    );
  }
  return null;
}
