import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  fieldNameSchema,
  type FieldDef,
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

/** What a type change is about to do, held while the person decides. */
interface PendingType {
  field: FieldDef;
  to: FieldType;
  values: number;
  incompatible: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Field management for one notebook: rename in place, change the type, edit a select's
 * options, reorder, delete. Modelled on the notebook list it is reached from, so the two
 * pages feel like one section.
 *
 * Two changes here can lose data and so go through `Confirm` naming what they will lose.
 * Deleting a field deletes its values. Changing a type keeps every value the new type can
 * read and clears the rest — the server is asked what that would be before anything is
 * written, so the confirmation carries the real number rather than a warning in the
 * abstract. Becoming a select never loses anything: the existing values become the
 * options.
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
      });
      setNewName('');
      setNewType('text');
      setNewOptions([]);
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
   * Asks first. The select snaps back to the current type while the confirmation is
   * open, because the type has not changed yet — the confirmation is what changes it.
   */
  async function changeType(field: FieldDef, to: FieldType) {
    if (to === field.type) return;
    setError(null);
    try {
      const preview = await api.previewFieldConversion(notebookId, field.id, to);
      if (preview.incompatible > 0) {
        setPendingType({ field, to, ...preview });
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    void run(() => api.updateNotebookField(notebookId, field.id, { type: to }));
  }

  function confirmType() {
    if (!pendingType) return;
    const { field, to } = pendingType;
    void run(async () => {
      await api.updateNotebookField(notebookId, field.id, { type: to });
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
                <FieldTypeIcon type={field.type} />
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
                value={field.type}
                disabled={busy}
                onChange={(e) => void changeType(field, e.target.value as FieldType)}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABELS[t]}
                  </option>
                ))}
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
          label="Confirm change field type"
          question={
            <>
              Change <strong>{pendingType.field.name}</strong> to{' '}
              {FIELD_TYPE_LABELS[pendingType.to]}?
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
            value={newType}
            disabled={busy}
            onChange={(e) => setNewType(e.target.value as FieldType)}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </span>
        <Button variant="primary" disabled={busy || !newName.trim()} onClick={create}>
          Add field
        </Button>
        {newType === 'select' && (
          <TagInput label="option" tags={newOptions} suggestions={[]} onChange={setNewOptions} />
        )}
      </div>

      <p className="muted small">
        Fields appear on every note in this notebook. Deleting a field deletes its values.
        Changing a field's type clears any value that can't be read as the new type. A note
        moved to another notebook keeps the values it has.
      </p>
    </div>
  );
}
