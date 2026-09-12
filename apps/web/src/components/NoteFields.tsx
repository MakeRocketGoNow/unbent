import { useState, type ReactNode } from 'react';
import {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  fieldNameSchema,
  type FieldDef,
  type FieldType,
  type FieldValue,
  type NoteFieldValue,
} from '@unbent/shared';
import { Button } from './Button';
import { FieldTypeIcon } from './icons.js';
import { usePersistentState } from '../usePersistentState.js';

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
 * field is the moment they are looking at the note that needs it. The chip opens into the
 * form in place, the way the tag entry does.
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
}: NoteFieldsProps) {
  const defs = notebookId ? definitions : [];
  // Sticks across notes and sessions: the notebooks whose empties are noise are noise
  // every time, and a toggle that reset on each note would be flipped on every visit.
  const [hideEmpty, setHideEmpty] = usePersistentState<boolean>(
    'noteFieldsHideEmpty',
    false,
    (raw) => (typeof raw === 'boolean' ? raw : undefined),
  );
  // Not yet known which fields the notebook has: showing every value as foreign for a
  // frame and then re-sorting it under a label would be exactly the jump to avoid.
  if (!defs) return null;

  const known = new Set(defs.map((d) => d.id));
  const foreign = carried.filter(
    (v) => !known.has(v.fieldId) && values[v.fieldId] !== null && values[v.fieldId] !== undefined,
  );

  const canAdd = !readOnly && notebookId !== null;
  if (defs.length === 0 && foreign.length === 0 && !canAdd) return null;

  const isEmpty = (def: FieldDef) => {
    const v = values[def.id];
    return v === null || v === undefined || v === '';
  };
  const empties = defs.filter(isEmpty).length;
  // The toggle is offered once the empties are worth hiding: a short list is read whole,
  // and hiding two rows of six only makes the list look like it lost something.
  const offerHide = defs.length >= HIDE_EMPTY_FROM && empties > 0;
  const shown = hideEmpty && offerHide ? defs.filter((d) => !isEmpty(d)) : defs;

  return (
    <div className="note-fields">
      {shown.map((def) => (
        <FieldRow
          key={def.id}
          def={def}
          value={values[def.id] ?? null}
          readOnly={readOnly}
          onChange={(v) => onChange(def.id, v)}
        />
      ))}
      {foreign.map((v) => (
        <div key={v.fieldId} className="note-field note-field-foreign" data-type={v.type}>
          <span className="note-field-glyph" aria-hidden="true">
            <FieldTypeIcon type={v.type} />
          </span>
          <span className="note-field-label">
            {v.name}
            <span className="note-field-origin">from {v.notebook}</span>
          </span>
          <span className="note-field-value">{String(v.value)}</span>
          <span className="note-field-side">
            {!readOnly && (
              <Button variant="quiet" size="small" onClick={() => onChange(v.fieldId, null)}>
                Clear
              </Button>
            )}
          </span>
        </div>
      ))}
      {(canAdd || offerHide) && (
        <div className="note-fields-foot">
          {canAdd && <AddField onAdd={onAddField} />}
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
          {canAdd && manage}
        </div>
      )}
    </div>
  );
}

interface FieldRowProps {
  def: FieldDef;
  value: FieldValue | null;
  readOnly: boolean;
  onChange: (value: FieldValue | null) => void;
}

function FieldRow({ def, value, readOnly, onChange }: FieldRowProps) {
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
      control = (
        <input
          {...common}
          {...blank}
          type="number"
          step="any"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      );
      break;
    case 'date':
      control = (
        <input {...common} type="date" value={text} onChange={(e) => setText(e.target.value)} />
      );
      break;
    case 'checkbox':
      control = (
        <input
          id={id}
          className="note-field-check"
          type="checkbox"
          disabled={readOnly}
          checked={value === true || value === 'true'}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
      break;
    case 'select': {
      // A value that is no longer among the options stays selectable rather than being
      // blanked: the note said it, and the option list changing is not the note's edit.
      const stale = text !== '' && !def.options.includes(text);
      control = (
        <select
          {...common}
          // The stylesheet draws a chosen option as a chip; an unchosen one as "Empty".
          data-filled={text !== '' || undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
      break;
    }
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
    <div className="note-field" data-type={def.type}>
      <span className="note-field-glyph" aria-hidden="true">
        <FieldTypeIcon type={def.type} />
      </span>
      <label className="note-field-label" htmlFor={id}>
        {def.name}
      </label>
      {control}
      <span className="note-field-side">{side}</span>
    </div>
  );
}

interface AddFieldProps {
  onAdd: (input: { name: string; type: FieldType; options: string[] }) => Promise<void>;
}

/**
 * "+ Add field", opening in place into a name, a type, and — for a select — its options.
 *
 * The name is checked here before it is sent, so a reserved name is refused with the
 * same words the server would use, without the round trip.
 */
function AddField({ onAdd }: AddFieldProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setOpen(false);
    setName('');
    setType('text');
    setOptions('');
    setError(null);
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
          type === 'select'
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

  if (!open) {
    return (
      <button type="button" className="note-field-add-hint" onClick={() => setOpen(true)}>
        <span className="tag-add-plus">+</span> Add field
      </button>
    );
  }

  return (
    <div className="note-field-add">
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
      {type === 'select' && (
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
      <Button variant="primary" size="small" disabled={busy || !name.trim()} onClick={() => void submit()}>
        Add
      </Button>
      <Button variant="quiet" size="small" disabled={busy} onClick={reset}>
        Cancel
      </Button>
      {error && <span className="note-field-error bad small">{error}</span>}
    </div>
  );
}
