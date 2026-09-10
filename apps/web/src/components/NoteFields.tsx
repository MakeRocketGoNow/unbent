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
 * A note's custom fields, under the notebook picker and the tags.
 *
 * Fields are the note's filing as much as the notebook is, so they sit in the same block
 * and keep its rhythm rather than getting a panel of their own. Each row is a label and a
 * control sized to the row's shared 1.65rem, in a grid so the labels line up: eight fields
 * should read as a form, not as eight rows that each found their own width.
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
  // Not yet known which fields the notebook has: showing every value as foreign for a
  // frame and then re-sorting it under a label would be exactly the jump to avoid.
  if (!defs) return null;

  const known = new Set(defs.map((d) => d.id));
  const foreign = carried.filter(
    (v) => !known.has(v.fieldId) && values[v.fieldId] !== null && values[v.fieldId] !== undefined,
  );

  const canAdd = !readOnly && notebookId !== null;
  if (defs.length === 0 && foreign.length === 0 && !canAdd) return null;

  return (
    <div className="note-fields">
      {defs.map((def) => (
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
          <span className="note-field-label">
            <FieldTypeIcon type={v.type} />
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
      {canAdd && (
        <div className="note-fields-foot">
          <AddField onAdd={onAddField} />
          {manage}
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

  let control: ReactNode;
  let side: ReactNode = null;
  switch (def.type) {
    case 'number':
      control = (
        <input
          {...common}
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
        <select {...common} value={text} onChange={(e) => setText(e.target.value)}>
          <option value="">—</option>
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
        <input {...common} type="url" value={text} onChange={(e) => setText(e.target.value)} />
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
        <input {...common} type="email" value={text} onChange={(e) => setText(e.target.value)} />
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
        <input {...common} type="tel" value={text} onChange={(e) => setText(e.target.value)} />
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
        <input {...common} type="text" value={text} onChange={(e) => setText(e.target.value)} />
      );
      break;
  }

  return (
    <div className="note-field" data-type={def.type}>
      <label className="note-field-label" htmlFor={id}>
        <FieldTypeIcon type={def.type} />
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
