import { useState, type ReactNode } from 'react';
import {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  fieldHasOptions,
  fieldNameSchema,
  isCurrencyField,
  isRatingField,
  type FieldDef,
  type FieldType,
  type FieldValue,
  type NoteFieldValue,
} from '@unbent/shared';
import { Button } from './Button';
import { FieldTypeIcon, PlusRowIcon } from './icons.js';
import { FieldCellInput } from './FieldCellInput.js';
import { amountText, currencySymbol, formatFieldValue } from './format-field.js';
import { usePersistentState } from '../usePersistentState.js';
import { filledStyle } from './filled.js';

export interface NoteFieldsProps {
  /** The note's notebook's definitions, in order. Undefined while they load. */
  definitions: FieldDef[] | undefined;
  /** The draft's values by field id; null is a cleared value. */
  values: Record<string, FieldValue | null>;
  /**
   * The values the server reported on the note. Only consulted for ids that are not in
   * `definitions`: those are values from a notebook the note has left, and this is where
   * their names come from.
   */
  carried: NoteFieldValue[];
  /** The notebook the note is filed in, or null. A field can only be added to a notebook. */
  notebookId: string | null;
  readOnly?: boolean;
  onChange: (fieldId: string, value: FieldValue | null) => void;
  /** Rejects with a message to show beside the form. */
  onAddField: (input: { name: string; type: FieldType; options: string[] }) => Promise<void>;
  /** Rendered last: the way to the notebook's field settings. */
  manage?: ReactNode;
  /**
   * The fields an Auto-fill press just wrote, marked for a moment (`.filled`), and where in
   * the press's order the first of them falls — the title and the filing rows above take
   * the places before it, so the marks run down the record as one sequence.
   */
  filled?: { ids: ReadonlySet<string>; start: number };
  /**
   * Rows rendered first, inside the same grid, so their labels share the fields' column.
   *
   * The phone puts the notebook and the tags here, as the first two properties of the
   * record: on a desktop they have a row of their own above the body, but on a phone
   * that row was a button opening a sheet for two controls, and two controls belong in
   * the list beside the others. Rows passed here draw themselves as `.note-field` rows.
   */
  lead?: ReactNode;
}

/**
 * A note's custom fields, as a property list.
 *
 * Drawn the way Notion draws a page's properties, which is what the people who will use
 * fields arrive knowing: a glyph for the type, the field's name, and the value as the
 * thing it is — text, a chip, a checkbox, a link — with no box around it. It used to be
 * a form, every value in a bordered input. That reads at five fields and fails at thirty:
 * thirty boxed inputs is a tax return, thirty rows of name and value is a record. The
 * glyphs came back for the same reason the drawer got them — a column with a picture
 * beside each word is scanned by looking, and "Amount" beside a hash reads as a number
 * without a type in brackets.
 *
 * What is *not* copied is Notion's editing mechanic. There, a click opens a separate
 * editor for every property, which on a phone is a dance of overlays and pickers. Here
 * the value is the control, all the time: it looks like text at rest and shows its edge
 * on hover and focus, so editing is a click into the value and typing, and nothing opens
 * over the thing being edited. The same rule the label editor follows.
 *
 * A value that is missing says "Empty" rather than showing a blank patch of screen, so
 * filled and unfilled are told apart at a glance; and once a notebook has enough fields
 * for the empties to be noise, they can be hidden — a preference that sticks, since the
 * notebooks that need it need it every time.
 *
 * A value the note carries from a notebook it has since left is shown, not hidden — it is
 * the note's data — but as text with a Clear rather than as a control. Editing it would
 * mean editing a field the note's notebook does not have, and moving the note back is the
 * way to do that.
 *
 * Adding a field happens here as well as in settings, because the moment someone wants a
 * field is the moment they are looking at the note that needs it. The form opens as one
 * more row of the list, in the list's own columns — see `AddFieldRow`.
 */
/** From this many fields, hiding the empty ones is offered. */
const HIDE_EMPTY_FROM = 8;

export function NoteFields({
  definitions,
  values,
  carried,
  notebookId,
  readOnly = false,
  onChange,
  onAddField,
  manage,
  lead,
  filled,
}: NoteFieldsProps) {
  const defs = notebookId ? definitions : [];
  // Sticks across notes and sessions: the notebooks whose empties are noise are noise
  // every time, and a toggle that reset on each note would be flipped on every visit.
  const [hideEmpty, setHideEmpty] = usePersistentState<boolean>(
    'noteFieldsHideEmpty',
    false,
    (raw) => (typeof raw === 'boolean' ? raw : undefined),
  );
  /*
   * Whether the add-field row is open. Held here rather than in the row, because the
   * foot draws different cells in each state — the "+ Add field" row at rest, the form's
   * cells while open — and the cells are the foot's to arrange.
   */
  const [adding, setAdding] = useState(false);
  // Not yet known which fields the notebook has: showing every value as foreign for a
  // frame and then re-sorting it under a label would be exactly the jump to avoid.
  if (!defs) return null;

  const known = new Set(defs.map((d) => d.id));
  const foreign = carried.filter(
    (v) => !known.has(v.fieldId) && values[v.fieldId] !== null && values[v.fieldId] !== undefined,
  );

  const canAdd = !readOnly && notebookId !== null;
  if (defs.length === 0 && foreign.length === 0 && !canAdd && !lead) return null;

  const isEmpty = (def: FieldDef) => {
    const v = values[def.id];
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  };
  const empties = defs.filter(isEmpty).length;
  // The toggle is offered once the empties are worth hiding: a short list is read whole,
  // and hiding two rows of six only makes the list look like it lost something.
  const offerHide = defs.length >= HIDE_EMPTY_FROM && empties > 0;
  const shown = hideEmpty && offerHide ? defs.filter((d) => !isEmpty(d)) : defs;

  let nextFilled = filled?.start ?? 0;
  return (
    <div className="note-fields">
      {lead}
      {shown.map((def) => (
        <FieldRow
          key={def.id}
          def={def}
          value={values[def.id] ?? null}
          readOnly={readOnly}
          filledAt={filled?.ids.has(def.id) ? nextFilled++ : undefined}
          onChange={(v) => onChange(def.id, v)}
        />
      ))}
      {foreign.map((v) => (
        <div key={v.fieldId} className="note-field note-field-foreign" data-type={v.type}>
          <span className="note-field-glyph" aria-hidden="true">
            <FieldTypeIcon type={v.type} />
          </span>
          <span className="note-field-label" title={`${v.name} from ${v.notebook}`}>
            {v.name}
            <span className="note-field-origin">from {v.notebook}</span>
          </span>
          <span className="note-field-value">{formatFieldValue(v.type, v.value, v.scale, v.currency)}</span>
          <span className="note-field-side">
            {!readOnly && (
              <Button variant="quiet" size="small" onClick={() => onChange(v.fieldId, null)}>
                Clear
              </Button>
            )}
          </span>
        </div>
      ))}
      {/*
          The last row of the list, in the list's own columns.

          At rest: a plus where a row's glyph goes, "Add field" where its name goes, the
          empties toggle where its value goes, and "Manage fields" in the side slot where a
          value's own action (Open, Call) goes — the way Notion ends a page's properties
          with "Add a property" in the property column. It used to be a dashed chip and a
          green link on a line of their own, two more costumes in a block that already had
          too many. While a field is being added the same four cells hold the form.
      */}
      {(canAdd || offerHide) && (
        <div className="note-fields-foot">
          {canAdd && adding ? (
            <AddFieldRow onAdd={onAddField} onDone={() => setAdding(false)} />
          ) : (
            <>
              <span className="note-field-glyph" aria-hidden="true">
                {canAdd && <PlusRowIcon />}
              </span>
              {canAdd ? (
                <button
                  type="button"
                  className="note-field-add-hint"
                  onClick={() => setAdding(true)}
                >
                  Add field
                </button>
              ) : (
                <span />
              )}
              {/*
                  One cell across the value and side columns, not a value cell and a side
                  cell. A grid column is as wide as its widest cell in any row, and "Manage
                  fields" in the side column widened that column for every row — on a phone
                  by enough to stack the tags one per line. A cell that spans the value
                  column's flexible track adds nothing to the side track's width, and the
                  link still sits hard right, where a value's own action would.
              */}
              <span className="note-fields-foot-rest">
                <span className="note-fields-foot-mid">
                  {offerHide && (
                    <button
                      type="button"
                      className="note-fields-toggle"
                      aria-pressed={hideEmpty}
                      onClick={() => setHideEmpty(!hideEmpty)}
                    >
                      {hideEmpty ? `Show ${empties} empty` : `Hide ${empties} empty`}
                    </button>
                  )}
                </span>
                {canAdd && manage}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface FieldRowProps {
  def: FieldDef;
  value: FieldValue | null;
  readOnly: boolean;
  /** This row's place among what an Auto-fill press just wrote, if it wrote this. */
  filledAt?: number | undefined;
  onChange: (value: FieldValue | null) => void;
}

function FieldRow({ def, value, readOnly, filledAt, onChange }: FieldRowProps) {
  // An amount's text while its input has focus; see the `number` case below.
  const [typing, setTyping] = useState<string | null>(null);
  const id = `field-${def.id}`;
  const text = value === null ? '' : String(value);
  const setText = (next: string) => onChange(next === '' ? null : next);
  const common = {
    id,
    className: 'note-field-input',
    disabled: readOnly,
  };

  /*
     "Empty" for a value that has none, as Notion writes it.

     The control is drawn with no border or fill at rest, so an empty text input is an
     empty patch of screen, and a field with no value would read as a rendering failure
     rather than as a blank. The word says what the blank is, and tells filled from
     unfilled at a glance, which with thirty rows is the first thing anyone wants.

     Only for the inputs that would otherwise render nothing. A checkbox and a date input
     draw their own empty state, and a select's is its first option — `placeholder` on a
     `<select>` is not a thing at all, which is why this is spread rather than folded
     into `common`.
  */
  const blank = { placeholder: 'Empty' };

  let control: ReactNode;
  let side: ReactNode = null;
  switch (def.type) {
    case 'number':
      if (isRatingField(def)) {
        // A rating is picked rather than typed, so it goes where the other picked
        // controls live and the table's cells get it for nothing.
        control = (
          <FieldCellInput id={id} def={def} value={value} readOnly={readOnly} onChange={onChange} />
        );
        break;
      }
      /*
         Not `type="number"`. A number input reports "" for any value that is not yet a
         valid float — "12.", "-", "12.5e" — and `setText` maps "" to null, which the
         draft treats as a clear. Autosave then deletes the stored amount while the user
         is still typing the decimal. `buildNotePatch` is written to *hold* "12." until it
         is a number; that only works if the string actually reaches the draft.

         `inputMode="decimal"` still brings up the numeric keypad on a phone. The
         property list also has no use for spinner buttons, which is the other thing
         `type="number"` would have drawn.
      */
      control = (
        <input
          {...common}
          {...blank}
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      );
      // An amount wears its currency's symbol before the digits, the way a price is
      // written, so the row reads as money without the input having to format what is
      // being typed. The input itself stays the plain number.
      if (isCurrencyField(def) && def.currency) {
        /*
           Written to the currency's cents at rest — `141.80`, not the `141.8` a stored
           number prints as — but exactly as typed while it has focus. Padding as the
           person types would turn "141.8" into "141.80" under the cursor, between the 8
           and the 5 they were about to press. So focus takes a copy of the text shown,
           typing edits that copy, and blur lets the padded form back.
        */
        const shown = typing ?? (value === null ? '' : amountText(value, def.currency));
        control = (
          <input
            {...common}
            {...blank}
            type="text"
            inputMode="decimal"
            value={shown}
            onFocus={() => setTyping(shown)}
            onBlur={() => setTyping(null)}
            onChange={(e) => {
              setTyping(e.target.value);
              setText(e.target.value);
            }}
          />
        );
        control = (
          <span className="note-field-money">
            <span className="note-field-affix" aria-hidden="true">
              {currencySymbol(def.currency)}
            </span>
            {control}
          </span>
        );
      }
      break;
    case 'date':
      control = (
        <input {...common} type="date" value={text} onChange={(e) => setText(e.target.value)} />
      );
      break;
    case 'checkbox':
    case 'select':
    case 'multiselect':
      // Shared with the table's cells, retired-option rule included; see `FieldCellInput`.
      control = (
        <FieldCellInput id={id} def={def} value={value} readOnly={readOnly} onChange={onChange} />
      );
      break;
    case 'url':
      control = (
        <input {...common} {...blank} type="url" value={text} onChange={(e) => setText(e.target.value)} />
      );
      if (/^https?:\/\//.test(text)) {
        side = (
          <a className="note-field-act" href={text} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        );
      }
      break;
    case 'email':
      control = (
        <input {...common} {...blank} type="email" value={text} onChange={(e) => setText(e.target.value)} />
      );
      if (text.includes('@')) {
        side = (
          <a className="note-field-act" href={`mailto:${text}`}>
            Email
          </a>
        );
      }
      break;
    case 'phone':
      control = (
        <input {...common} {...blank} type="tel" value={text} onChange={(e) => setText(e.target.value)} />
      );
      if (text) {
        side = (
          <a className="note-field-act" href={`tel:${text.replace(/[^\d+]/g, '')}`}>
            Call
          </a>
        );
      }
      break;
    case 'text':
      control = (
        <input {...common} {...blank} type="text" value={text} onChange={(e) => setText(e.target.value)} />
      );
      break;
  }

  return (
    <div
      className={filledAt === undefined ? 'note-field' : 'note-field filled'}
      data-type={def.type}
      style={filledStyle(filledAt)}
    >
      <span className="note-field-glyph" aria-hidden="true">
        <FieldTypeIcon type={def.type} rating={isRatingField(def)} currency={isCurrencyField(def)} />
      </span>
      {/* The title carries the whole name for one the fixed name column has to cut. */}
      <label className="note-field-label" htmlFor={id} title={def.name}>
        {def.name}
      </label>
      {control}
      <span className="note-field-side">{side}</span>
    </div>
  );
}

interface AddFieldRowProps {
  onAdd: (input: { name: string; type: FieldType; options: string[] }) => Promise<void>;
  /** Called once the field is added or the form is dismissed. */
  onDone: () => void;
}

/**
 * The add-field form, as a row of the list: the cells of the foot while a field is being
 * added.
 *
 * The type's glyph where a row's glyph goes — it changes as the type is chosen, so the
 * row previews itself — the name where a name goes, the type and, for a select, its
 * options where the value goes, and Add and Cancel in the side slot. It used to be a run
 * of controls dropped into the list, with the name boxed because it had focus and the
 * options bare because they did not: the quiet-at-rest rule applied per control inside a
 * form where every control is being edited. Here the stylesheet boxes all of them while
 * the row is open, since it is one edit, not three.
 *
 * The name is checked here before it is sent, so a reserved name is refused with the
 * same words the server would use, without the round trip.
 */
function AddFieldRow({ onAdd, onDone }: AddFieldRowProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setName('');
    setType('text');
    setOptions('');
    setError(null);
    onDone();
  }

  async function submit() {
    const parsed = fieldNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Give the field a name');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd({
        name: parsed.data,
        type,
        options:
          fieldHasOptions(type)
            ? options
                .split(',')
                .map((o) => o.trim())
                .filter((o) => o.length > 0)
            : [],
      });
      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape') reset();
  };

  return (
    <>
      <span className="note-field-glyph" aria-hidden="true">
        <FieldTypeIcon type={type} />
      </span>
      <input
        className="note-field-input"
        placeholder="Field name"
        aria-label="Field name"
        value={name}
        autoFocus
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="note-field-add-value">
        <select
          className="note-notebook"
          aria-label="Field type"
          value={type}
          disabled={busy}
          onChange={(e) => setType(e.target.value as FieldType)}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {fieldHasOptions(type) && (
          <input
            className="note-field-input"
            placeholder="Options, separated by commas"
            aria-label="Options"
            value={options}
            disabled={busy}
            onChange={(e) => setOptions(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
      </span>
      {/* In the side slot on a desktop; a phone moves the pair to a line of their own, so
          two buttons do not widen the side column under every row while the form is open. */}
      <span className="note-field-side note-field-add-actions">
        <Button variant="primary" size="small" disabled={busy || !name.trim()} onClick={() => void submit()}>
          Add
        </Button>
        <Button variant="quiet" size="small" disabled={busy} onClick={reset}>
          Cancel
        </Button>
      </span>
      {error && <span className="note-field-error bad small">{error}</span>}
    </>
  );
}
