import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  MAX_RATING_MAX,
  MIN_RATING_MAX,
  fieldNameSchema,
  isRatingField,
  type FieldDef,
  type FieldScale,
  type FieldType,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { keys, notebookFieldsQuery, notebooksQuery } from '../queries.js';
import { Button } from './Button';
import { Confirm } from './Confirm.js';
import { TagInput } from './TagInput.js';
import { FieldTypeIcon, MoveDownIcon, MoveUpIcon } from './icons.js';

interface NotebookFieldsProps {
  notebookId: string;
  /** Called after any change, so the notebook list, the note list and open notes refetch. */
  onChanged: () => void;
}

/** What a type or scale change is about to do, held while the person decides. */
interface PendingType {
  field: FieldDef;
  to: FieldType;
  /**
   * Set when the change involves a scale: arriving, going away, or tightening. See
   * `changeType` and `changeScale`.
   */
  scale?: FieldScale | null;
  values: number;
  incompatible: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Field management for one notebook: rename in place, change the type, edit a select's
 * options, reorder, delete. Modelled on the notebook list it is reached from, so the two
 * pages feel like one section.
 *
 * Three changes here can lose data and so go through `Confirm` naming what they will lose.
 * Deleting a field deletes its values. Changing a type keeps every value the new type can
 * read and clears the rest. Tightening a rating's scale does the same — a 7 cannot stay
 * on a 5-point scale, and a 3.5 cannot stay once half steps are dropped. In both of those
 * the server is asked what would be cleared before anything is written, so the confirmation
 * carries the real number rather than a warning in the abstract. Becoming a select never
 * loses anything: the existing values become the options. Widening a scale never loses
 * anything either, and writes without asking.
 *
 * Order is set with up/down rather than drag. A dozen fields is the realistic maximum,
 * two buttons work with a keyboard and on a phone, and drag-to-reorder is a component
 * this codebase does not have yet — the list items say the same (see README).
 */
export function NotebookFields({ notebookId, onChanged }: NotebookFieldsProps) {
  const queryClient = useQueryClient();
  const fields = useQuery(notebookFieldsQuery(notebookId));
  const notebooks = useQuery(notebooksQuery());
  const notebook = notebooks.data?.notebooks.find((nb) => nb.id === notebookId);

  /** Id of the field being renamed, with its in-progress value. */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FieldDef | null>(null);
  const [pendingType, setPendingType] = useState<PendingType | null>(null);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<FieldType>('text');
  const [newOptions, setNewOptions] = useState<string[]>([]);
  /*
     "Rating" is a choice in the type picker, but not a field type: it is a `number` that
     carries a scale. The picker is where a person looks for it — nobody adding a star
     rating goes looking for "Number" and then a scale — so the kind is held here and
     turned back into a type and a scale at the moment the field is created.
  */
  const [newIsRating, setNewIsRating] = useState(false);
  const [newScale, setNewScale] = useState<FieldScale>({ max: 5, step: 0.5 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Runs a mutation, then refetches this page and the app behind it. */
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function create() {
    const parsed = fieldNameSchema.safeParse(newName);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Give the field a name');
      return;
    }
    void run(async () => {
      await api.createNotebookField(notebookId, {
        name: parsed.data,
        type: newType,
        options: newType === 'select' ? newOptions : [],
        ...(newIsRating ? { scale: newScale } : {}),
      });
      setNewName('');
      setNewType('text');
      setNewOptions([]);
      setNewIsRating(false);
      setNewScale({ max: 5, step: 0.5 });
    });
  }

  function commitRename() {
    if (!editing) return;
    const { id, value } = editing;
    const original = fields.data?.find((f) => f.id === id)?.name;
    const parsed = fieldNameSchema.safeParse(value);
    // A no-op rename would otherwise 409 against the field's own name.
    if (!parsed.success || parsed.data === original) {
      setEditing(null);
      if (!parsed.success && value.trim() !== '') {
        setError(parsed.error.issues[0]?.message ?? 'Give the field a name');
      }
      return;
    }
    void run(async () => {
      await api.updateNotebookField(notebookId, id, { name: parsed.data });
      setEditing(null);
    });
  }

  /**
   * Changes a field's type, or turns a number into a rating and back.
   *
   * Asks first. The select snaps back to the current type while the confirmation is open,
   * because the type has not changed yet — the confirmation is what changes it.
   *
   * `scale` is what the picker's "Rating" and "Number" entries differ by: both are the
   * `number` type, so a switch between them is a scale arriving or going away rather than
   * a type change. It still goes through the preview, because gaining a scale can clear
   * values — a stored 0 or 250 is no longer a legal rating — and that is exactly the
   * confirmation a type change gets.
   */
  async function changeType(field: FieldDef, to: FieldType, scale?: FieldScale | null) {
    const scaleChanged = scale !== undefined && (scale === null) !== (field.scale === null);
    if (to === field.type && !scaleChanged) return;
    setError(null);
    try {
      const preview = await api.previewFieldConversion(notebookId, field.id, to, scale);
      if (preview.incompatible > 0) {
        setPendingType({ field, to, scale, ...preview });
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    void run(() =>
      api.updateNotebookField(notebookId, field.id, {
        type: to,
        ...(scale !== undefined ? { scale } : {}),
      }),
    );
  }

  /**
   * Tightening a rating's scale can throw values away, so it uses the same preview the
   * type picker does. The scale controls themselves write immediately when nothing would
   * be cleared — widening 5 to 10, or narrowing past values nobody used — and only stop
   * for confirmation when the server names a count.
   *
   * Both controls stay on the current scale while that confirmation is open — the select
   * and the half-steps checkbox alike, since each draws from `field.scale`. That is the
   * same snap-back the type select does: the scale has not changed yet, and the
   * confirmation is what changes it.
   *
   * Only reached from `ScalePicker`, which renders only for a field that has a scale, so
   * `field.scale` is non-null here.
   */
  async function changeScale(field: FieldDef, scale: FieldScale) {
    if (field.scale?.max === scale.max && field.scale.step === scale.step) return;
    setError(null);
    try {
      const preview = await api.previewFieldConversion(notebookId, field.id, field.type, scale);
      if (preview.incompatible > 0) {
        setPendingType({ field, to: field.type, scale, ...preview });
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    void run(() => api.updateNotebookField(notebookId, field.id, { scale }));
  }

  function confirmType() {
    if (!pendingType) return;
    const pending = pendingType;
    const { field, to, scale } = pending;
    void run(async () => {
      await api.updateNotebookField(notebookId, field.id, {
        // A scale tighten is not a type change, and `changeScale` writes it without a
        // `type`. Sending one here anyway is a no-op server-side, but it would make the
        // two paths for one intent send different bodies.
        ...(scaleOnlyConfirm(pending) ? {} : { type: to }),
        ...(scale !== undefined ? { scale } : {}),
      });
      setPendingType(null);
    });
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    void run(async () => {
      await api.deleteNotebookField(notebookId, id);
      setPendingDelete(null);
    });
  }

  /** Optimistic: the row moves now, and the order is written behind it. */
  function move(index: number, by: -1 | 1) {
    const current = fields.data ?? [];
    const target = index + by;
    if (target < 0 || target >= current.length) return;
    const next = [...current];
    [next[index], next[target]] = [next[target]!, next[index]!];
    queryClient.setQueryData(
      keys.notebookFields(notebookId),
      next.map((f, position) => ({ ...f, position })),
    );
    void run(() =>
      api.reorderNotebookFields(
        notebookId,
        next.map((f) => f.id),
      ),
    );
  }

  const list = fields.data ?? [];

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{notebook ? `Fields in ${notebook.name}` : 'Fields'}</h2>
        <Link to="/settings/notebooks" className="link small">
          All notebooks
        </Link>
      </div>

      {error && <p className="bad small">{error}</p>}

      <ul className="notebook-admin field-admin">
        {list.map((field, index) => (
          <li key={field.id}>
            {editing?.id === field.id ? (
              <input
                className="search-field"
                value={editing.value}
                autoFocus
                disabled={busy}
                aria-label="Field name"
                onChange={(e) => setEditing({ id: field.id, value: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="notebook-admin-name"
                title="Rename"
                onClick={() => setEditing({ id: field.id, value: field.name })}
              >
                <FieldTypeIcon type={field.type} rating={isRatingField(field)} />
                {field.name}
                {field.valueCount !== undefined && field.valueCount > 0 && (
                  <span className="tag-count" title={`${plural(field.valueCount, 'note')} with a value`}>
                    {field.valueCount}
                  </span>
                )}
              </button>
            )}

            <span className="notebook-scope-wrap field-admin-type">
              <select
                className="notebook-scope"
                aria-label={`Type of ${field.name}`}
                value={isRatingField(field) ? 'rating' : field.type}
                disabled={busy}
                onChange={(e) => {
                  const picked = e.target.value;
                  if (picked === 'rating') {
                    // Turning a number into a rating: the scale it starts on is the one
                    // the create form offers, which is the shape most ratings want.
                    void changeType(field, 'number', { max: 5, step: 0.5 });
                  } else {
                    // Away from a rating, the scale goes with it — `null` rather than
                    // undefined, which would leave the old scale bounding the field.
                    void changeType(field, picked as FieldType, field.scale ? null : undefined);
                  }
                }}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABELS[t]}
                  </option>
                ))}
                <option value="rating">Rating</option>
              </select>
            </span>

            <span className="notebook-admin-actions">
              <Button
                variant="quiet"
                size="small"
                aria-label={`Move ${field.name} up`}
                disabled={busy || index === 0}
                onClick={() => move(index, -1)}
              >
                <MoveUpIcon />
              </Button>
              <Button
                variant="quiet"
                size="small"
                aria-label={`Move ${field.name} down`}
                disabled={busy || index === list.length - 1}
                onClick={() => move(index, 1)}
              >
                <MoveDownIcon />
              </Button>
              <Button
                variant="quiet"
                tone="danger"
                size="small"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setPendingDelete(field);
                }}
              >
                Delete
              </Button>
            </span>

            {field.type === 'select' && (
              <div className="field-admin-options">
                <TagInput
                  label="option"
                  tags={field.options}
                  suggestions={[]}
                  onChange={(options) =>
                    void run(() => api.updateNotebookField(notebookId, field.id, { options }))
                  }
                />
              </div>
            )}

            {isRatingField(field) && field.scale && (
              <ScalePicker
                scale={field.scale}
                disabled={busy}
                onChange={(scale) => void changeScale(field, scale)}
              />
            )}
          </li>
        ))}

        {list.length === 0 && fields.isSuccess && (
          <li className="muted small">No fields yet. Notes in this notebook will get every field you add here.</li>
        )}
      </ul>

      {pendingDelete && (
        <Confirm
          label="Confirm delete field"
          question={
            <>
              Delete the field <strong>{pendingDelete.name}</strong>?
            </>
          }
          detail={
            pendingDelete.valueCount
              ? `Its values on ${plural(pendingDelete.valueCount, 'note')} will be deleted.`
              : 'No note has a value for it.'
          }
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          actions={[
            { label: 'Delete field', busyLabel: 'Deleting…', tone: 'danger', onConfirm: confirmDelete },
          ]}
        />
      )}

      {pendingType && (
        <Confirm
          label={scaleOnlyConfirm(pendingType) ? 'Confirm change rating scale' : 'Confirm change field type'}
          question={
            <>
              {scaleOnlyConfirm(pendingType) ? (
                scaleConfirmQuestion(pendingType)
              ) : (
                <>
                  Change <strong>{pendingType.field.name}</strong> to{' '}
                  {/* Named as the picker names it: "to Number" would be the wrong word for a
                      number gaining a scale, which is the change the person just asked for. */}
                  {pendingType.scale ? 'Rating' : FIELD_TYPE_LABELS[pendingType.to]}?
                </>
              )}
            </>
          }
          detail={
            `${plural(pendingType.values, 'note')} ${pendingType.values === 1 ? 'has' : 'have'} a value. ` +
            (pendingType.incompatible === pendingType.values
              ? pendingType.incompatible === 1
                ? "It can't be read that way and will be cleared."
                : 'None of them can be read that way, so all will be cleared.'
              : `${pendingType.incompatible} of them can't be read that way and will be cleared.`)
          }
          busy={busy}
          onCancel={() => setPendingType(null)}
          actions={[
            {
              label: `Change and clear ${plural(pendingType.incompatible, 'value')}`,
              busyLabel: 'Changing…',
              tone: 'danger',
              onConfirm: confirmType,
            },
          ]}
        />
      )}

      <div className="notebook-admin-new field-admin-new">
        <input
          className="search-field"
          value={newName}
          placeholder="New field name"
          aria-label="New field name"
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <span className="notebook-scope-wrap field-admin-type">
          <select
            className="notebook-scope"
            aria-label="New field type"
            value={newIsRating ? 'rating' : newType}
            disabled={busy}
            onChange={(e) => {
              const picked = e.target.value;
              setNewIsRating(picked === 'rating');
              setNewType(picked === 'rating' ? 'number' : (picked as FieldType));
            }}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
            {/* Last, and named for what it is rather than for what it stores. */}
            <option value="rating">Rating</option>
          </select>
        </span>
        <Button variant="primary" disabled={busy || !newName.trim()} onClick={create}>
          Add field
        </Button>
        {newType === 'select' && !newIsRating && (
          <TagInput label="option" tags={newOptions} suggestions={[]} onChange={setNewOptions} />
        )}
        {newIsRating && (
          <ScalePicker scale={newScale} disabled={busy} onChange={setNewScale} />
        )}
      </div>

      <p className="muted small">
        Fields appear on every note in this notebook. Deleting a field deletes its values.
        Changing a field's type, or narrowing a rating's scale, clears any value that can't
        be read that way. A note moved to another notebook keeps the values it has.
      </p>
    </div>
  );
}

/**
 * Whether `pending` is a scale tighten on a field that is already a rating, rather than
 * a type change (including a number becoming a rating, which is a scale arriving).
 *
 * The confirm copy hangs on this: "Change to Rating" is the wrong question for dropping
 * a 10-point scale to 5, and "out of 5" is the wrong question for turning a number into
 * stars.
 */
function scaleOnlyConfirm(
  pending: PendingType,
): pending is PendingType & { scale: FieldScale; field: FieldDef & { scale: FieldScale } } {
  return pending.to === pending.field.type && pending.scale != null && pending.field.scale != null;
}

function scaleConfirmQuestion(pending: PendingType & { scale: FieldScale; field: FieldDef & { scale: FieldScale } }) {
  const prev = pending.field.scale;
  const maxChanged = pending.scale.max !== prev.max;
  const losingHalves = pending.scale.step > prev.step;

  // Both controls can be in play at once. Naming only the max would read as though the
  // halves survive, and they are exactly what gets cleared.
  if (losingHalves && !maxChanged) {
    return (
      <>
        Drop half steps on <strong>{pending.field.name}</strong>?
      </>
    );
  }
  if (losingHalves) {
    return (
      <>
        Change <strong>{pending.field.name}</strong> to out of {pending.scale.max}, without half steps?
      </>
    );
  }
  return (
    <>
      Change <strong>{pending.field.name}</strong> to out of {pending.scale.max}?
    </>
  );
}

/**
 * A rating's scale: how high it goes, and whether halves count.
 *
 * Two controls rather than one list of combinations, because they are two independent
 * questions and a person arrives with an answer to each. Narrowing can throw a value
 * away, so the caller previews first and confirms when the server names a count — the
 * same path a type change takes, rather than writing and then saying how many were lost.
 * The note under the controls is only how the scale will draw, not a substitute for that.
 */
function ScalePicker({
  scale,
  disabled,
  onChange,
}: {
  scale: FieldScale;
  disabled?: boolean;
  onChange: (scale: FieldScale) => void;
}) {
  const maxes: number[] = [];
  for (let m = MIN_RATING_MAX; m <= MAX_RATING_MAX; m += 1) maxes.push(m);

  return (
    <div className="field-admin-scale">
      <label className="notebook-scope-wrap">
        <span className="muted small">Out of</span>
        <select
          className="notebook-scope"
          aria-label="Rating scale maximum"
          value={scale.max}
          disabled={disabled}
          onChange={(e) => onChange({ ...scale, max: Number(e.target.value) })}
        >
          {maxes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label className="field-admin-halves">
        <input
          type="checkbox"
          checked={scale.step === 0.5}
          disabled={disabled}
          onChange={(e) => onChange({ ...scale, step: e.target.checked ? 0.5 : 1 })}
        />
        <span className="muted small">Half steps</span>
      </label>
      {/* Five with halves is ten levels in five glyphs, which is the shape most people
          mean by "out of ten"; above five the value is drawn as a number over its max. */}
      <span className="muted small">
        {scale.max > 5
          ? `Shown as a number out of ${scale.max}.`
          : scale.step === 0.5
            ? `Shown as ${scale.max} stars, half steps allowed.`
            : `Shown as ${scale.max} stars.`}
      </span>
    </div>
  );
}
