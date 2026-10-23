import { useNavigate } from '@tanstack/react-router';
import { fieldHasOptions, parseFieldFilter, formatFieldFilter, type FieldDef, type FieldFilter } from '@unbent/shared';
import { fieldFilterLabel } from './field-filter.js';
import { FieldTypeIcon } from './icons.js';
import { writeFieldFilter } from '../routes/notes.js';

interface FieldsPickerProps {
  /** The selected notebook's definitions, in their display order. */
  defs: FieldDef[];
  /** The filters as the URL carries them. */
  selected: string[];
}

/**
 * Narrow the list by the selected notebook's fields: a page of the filter sheet.
 *
 * One row per field, each carrying the control its type wants. A select, a multi-select,
 * a checkbox and the text-like types get a `<select>`: "Any", then the values it can
 * equal (for a multi-select, the options it can hold), then whether it is set or empty
 * at all. A number and a date get a pair of bounds, either end open,
 * the way the date range page's custom fields work: a range is two fields, and a row
 * that returned to the root after the first would take the second away mid-edit. Text
 * "contains" is not offered: the search box already reads field values.
 *
 * Every change writes the URL at once, as `DatePicker` does; there is no Apply. The chips
 * above the list report what is set, so a change is visible the moment it is made, and
 * an Apply button would be a second place to say what the list already shows.
 *
 * The rows are the definitions, not the filters. A page listing only what is set would
 * have nothing on it the first time, which is when it is opened.
 */
export function FieldsPicker({ defs, selected }: FieldsPickerProps) {
  const navigate = useNavigate();
  const current = selected
    .map((raw) => parseFieldFilter(raw))
    .filter((f): f is FieldFilter => f !== null);

  /** Replaces this field's filters of the given ops with `next`, keeping everything else. */
  const write = (fieldId: string, ops: FieldFilter['op'][], next: FieldFilter[]) => {
    const kept = current.filter((f) => !(f.fieldId === fieldId && ops.includes(f.op)));
    void navigate({
      to: '/notes',
      search: (prev) => ({
        ...prev,
        field: writeFieldFilter([...kept, ...next].map(formatFieldFilter)),
      }),
    });
  };

  return (
    <div className="fields-picker">
      {defs.map((def) => {
        const mine = current.filter((f) => f.fieldId === def.id);
        const ranged = def.type === 'number' || def.type === 'date';
        return (
          <div className="fields-picker-row" key={def.id}>
            <span className="fields-picker-name">
              <FieldTypeIcon type={def.type} />
              {def.name}
            </span>
            {ranged ? (
              <RangeControl def={def} mine={mine} write={write} />
            ) : (
              <ChoiceControl def={def} mine={mine} write={write} />
            )}
          </div>
        );
      })}
    </div>
  );
}

type Write = (fieldId: string, ops: FieldFilter['op'][], next: FieldFilter[]) => void;

/**
 * A select whose options are the ways this field can be narrowed. Option values carry
 * the op and, for equality, the value after a colon: the same shape as the wire form,
 * so reading one back is `parseFieldFilter` with the id put in front.
 *
 * A checkbox offers two answers and no "Is set" or "Is empty". Unchecked is `ne:true`,
 * which takes in the notes whose box was never touched: a box stores `false` once it has
 * been ticked and unticked, and nobody looking for "not used" means only those. With
 * set/empty beside them, Unchecked and Is empty read as the same question and gave
 * different answers.
 */
function ChoiceControl({ def, mine, write }: { def: FieldDef; mine: FieldFilter[]; write: Write }) {
  const one = mine[0];
  const checkbox = def.type === 'checkbox';
  const value = one ? formatFieldFilter(one).slice(def.id.length + 1) : '';
  const values = [
    ...(fieldHasOptions(def.type) ? def.options.map((o) => ({ value: `eq:${o}`, label: o })) : []),
    ...(checkbox
      ? [
          { value: 'eq:true', label: 'Checked' },
          { value: 'ne:true', label: 'Unchecked' },
        ]
      : [
          { value: 'set', label: 'Is set' },
          { value: 'empty', label: 'Is empty' },
        ]),
  ];
  // A filter from a link that none of these spell (an older link's `eq:false`, an
  // assistant's `empty` on a checkbox) is still drawn, in words, rather than as Any while
  // it narrows the list.
  if (one && value && !values.some((v) => v.value === value)) {
    values.push({ value, label: fieldFilterLabel(formatFieldFilter(one), [def]) });
  }
  return (
    <select
      className="notebook-scope"
      aria-label={def.name}
      value={value}
      onChange={(e) => {
        const next = e.target.value ? parseFieldFilter(`${def.id}:${e.target.value}`) : null;
        write(def.id, ['eq', 'ne', 'set', 'empty', 'gte', 'lte'], next ? [next] : []);
      }}
    >
      <option value="">Any</option>
      {values.map((v) => (
        <option key={v.value} value={v.value}>
          {v.label}
        </option>
      ))}
    </select>
  );
}

/** Two bounds, either end open. A number's are numbers; a date's are days. */
function RangeControl({ def, mine, write }: { def: FieldDef; mine: FieldFilter[]; write: Write }) {
  const from = mine.find((f) => f.op === 'gte')?.value ?? '';
  const to = mine.find((f) => f.op === 'lte')?.value ?? '';
  const type = def.type === 'date' ? 'date' : 'number';
  const bound = (op: 'gte' | 'lte', raw: string) =>
    write(def.id, [op], raw ? [{ fieldId: def.id, op, value: raw }] : []);
  return (
    <div className="date-range">
      <label>
        <span className="small">{def.type === 'date' ? 'From' : 'Min'}</span>
        <input
          type={type}
          value={from}
          aria-label={`${def.name}, ${def.type === 'date' ? 'from' : 'minimum'}`}
          max={to || undefined}
          onChange={(e) => bound('gte', e.target.value)}
        />
      </label>
      <label>
        <span className="small">{def.type === 'date' ? 'To' : 'Max'}</span>
        <input
          type={type}
          value={to}
          aria-label={`${def.name}, ${def.type === 'date' ? 'to' : 'maximum'}`}
          min={from || undefined}
          onChange={(e) => bound('lte', e.target.value)}
        />
      </label>
    </div>
  );
}
