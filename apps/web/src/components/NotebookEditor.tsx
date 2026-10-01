import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CURRENCY_CODES,
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  MAX_NOTEBOOK_PURPOSE_LENGTH,
  MAX_RATING_MAX,
  MIN_RATING_MAX,
  notebookNameSchema,
  fieldHasOptions,
  fieldNameSchema,
  isCurrencyField,
  isRatingField,
  type FieldDef,
  type FieldScale,
  type FieldType,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { SAVE_LABEL, useAutosave, type SaveState } from '../useAutosave.js';
import { keys, notebookFieldCountsQuery, notebooksQuery } from '../queries.js';
import { Button } from './Button';
import { Confirm } from './Confirm.js';
import { DeleteNotebookConfirm } from './DeleteNotebookConfirm.js';
import { EmojiField } from './EmojiField.js';
import { TagInput } from './TagInput.js';
import { formatCurrency } from './format-field.js';
import { FieldTypeIcon, MoveDownIcon, MoveUpIcon } from './icons.js';

interface NotebookEditorProps {
  notebookId: string;
  /** Called after any change, so the notebook list, the note list and open notes refetch. */
  onChanged: () => void;
  /** Called after the notebook is deleted, so the route can leave for the list. */
  onDeleted: () => void;
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
  /** Set when the change puts a currency on the field or takes one off; see `changeType`. */
  currency?: string | null;
  values: number;
  incompatible: number;
}

/**
 * Removing a select option that notes still use, held while the person decides whether to
 * keep those values or clear them. Only ever set when `usage > 0`: an option no note uses
 * is removed without asking.
 */
interface PendingOption {
  field: FieldDef;
  option: string;
  usage: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a field becomes when "Currency" is picked; the picker under it changes it. */
const DEFAULT_CURRENCY = 'USD';

/**
 * Field management for one notebook: rename in place, change the type, edit a select's or
 * multi-select's options, reorder, delete. Modelled on the notebook list it is reached
 * from, so the two pages feel like one section.
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
 * Order is set with two buttons rather than drag, for the fields here and for a select's
 * options alike. A dozen fields is the realistic maximum, two buttons work with a keyboard
 * and on a phone, and drag-to-reorder is a component this codebase does not have yet — the
 * list items say the same (see README). The fields are a column and move up/down; a
 * select's options wrap as chips and move earlier/later, but it is the same one-step nudge.
 */
export function NotebookEditor({ notebookId, onChanged, onDeleted }: NotebookEditorProps) {
  const queryClient = useQueryClient();
  const fields = useQuery(notebookFieldCountsQuery(notebookId));
  const notebooks = useQuery(notebooksQuery());
  const notebook = notebooks.data?.notebooks.find((nb) => nb.id === notebookId);

  /**
   * The notebook name's own draft, seeded and followed like the purpose below. The rename
   * autosaves as you type (see `useAutosave` below); a clash comes back as an error and the
   * draft is left as the person typed it so they can fix it rather than losing it.
   */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  /** Set while the two-option delete confirm is open for this whole notebook. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Id of the field being renamed, with its in-progress value. */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  /**
   * The purpose textarea's own draft. Seeded from the notebook once it loads and whenever
   * the saved value changes under it, but otherwise left to the person's keystrokes — a
   * controlled textarea bound straight to the query would fight the caret on every refetch.
   */
  const [purposeDraft, setPurposeDraft] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FieldDef | null>(null);
  const [pendingType, setPendingType] = useState<PendingType | null>(null);
  const [pendingOption, setPendingOption] = useState<PendingOption | null>(null);
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
  // "Currency" is the same kind of picker entry as "Rating": a `number` with something
  // beside it, held here and turned back into a type and a currency on create.
  const [newIsCurrency, setNewIsCurrency] = useState(false);
  const [newCurrency, setNewCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
     The removal popover dismisses on a click outside it, the way a popover should. Escape
     and its own Cancel already close it (see `Confirm`); this adds the third way people
     reach for. Guarded by `busy` so a click landing while the removal is in flight cannot
     tear the popover down mid-write, and skipped entirely while nothing is open. The chip's
     own remove button lives outside the popover, so a listener that fired on it would close
     and reopen in one gesture — but that button is disabled by `busy` during the run and is
     never what dismisses, so a plain contains-check is enough.

     A layout effect, not a passive one, so the listener exists the instant the popover is
     in the DOM. The popover opens from a promise continuation (after the usage count comes
     back), which React commits on its scheduler rather than inside an event, and it then
     flushes passive effects in a later task. That leaves a moment where the popover is
     visible but a pointer down outside it does nothing. No person can click inside it, but
     the test that pins this behaviour can: `waitFor` sees the popover as soon as it is
     committed and fires the pointer down before that later task has run — reliably on a
     slow CI runner, where the timer Testing Library drains with fires before React's task.
  */
  const optionConfirmRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!pendingOption || busy) return;
    const onDown = (e: PointerEvent) => {
      if (!optionConfirmRef.current?.contains(e.target as Node)) setPendingOption(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pendingOption, busy]);

  // Seed the name and purpose drafts into the controlled inputs from the notebook, and
  // follow the saved values when they change under us (another tab, a fresh load) — but only
  // while a draft is still unseeded, so a save landing does not wipe what the person is
  // mid-typing. The autosave hooks below track these drafts once seeded.
  const savedName = notebook?.name ?? '';
  const savedPurpose = notebook?.purpose ?? '';
  useEffect(() => {
    setNameDraft((draft) => (draft === null ? savedName : draft));
  }, [savedName]);
  useEffect(() => {
    setPurposeDraft((draft) => (draft === null ? savedPurpose : draft));
  }, [savedPurpose]);

  /**
   * Name and purpose autosave the way a note's body does: debounced as you type, and — the
   * reason it is the hook and not a blur handler — flushed on unmount and on tab hide, so
   * clicking a nav link or closing the tab mid-edit still saves the last change rather than
   * dropping it. Only enabled once the draft is seeded from the notebook, so the seed itself
   * is never mistaken for an edit (the same guard the note editor relies on).
   */
  const seeded = notebook !== undefined && nameDraft !== null && purposeDraft !== null;

  /**
   * Saves the name when it is a real, valid change. An empty or unseeded draft, or one equal
   * to the saved name, is `'unchanged'` — the hook's honest no-op, so a name typed back to
   * itself never 409s against its own row and the indicator does not flash a false Saved. A
   * clash throws, which the hook surfaces as the error the header shows.
   */
  const saveName = useCallback(
    async (draft: string | null): Promise<void | 'unchanged'> => {
      const parsed = notebookNameSchema.safeParse(draft ?? '');
      if (!parsed.success || parsed.data === savedName) return 'unchanged';
      await api.updateNotebook(notebookId, { name: parsed.data });
      onChanged();
    },
    [notebookId, savedName, onChanged],
  );

  /**
   * Saves the purpose when it changed. A blank draft clears it to `null` rather than storing
   * an empty string; a draft equal to the saved purpose is `'unchanged'`. The comparison is
   * on trimmed text, so a space typed and removed is not a save.
   */
  const savePurpose = useCallback(
    async (draft: string | null): Promise<void | 'unchanged'> => {
      if (draft === null) return 'unchanged';
      const next = draft.trim();
      if (next === savedPurpose.trim()) return 'unchanged';
      await api.updateNotebook(notebookId, { purpose: next.length > 0 ? next : null });
      onChanged();
    },
    [notebookId, savedPurpose, onChanged],
  );

  const { state: nameState, error: nameError, flush: flushName } = useAutosave(nameDraft, saveName, {
    enabled: seeded,
    resetKey: notebookId,
  });
  const { state: purposeState, error: purposeError } = useAutosave(purposeDraft, savePurpose, {
    enabled: seeded,
    resetKey: notebookId,
  });

  /**
   * One state for the header, from the two autosaves: the worse of the two, since the header
   * only says whether the page is safe to leave. Error beats saving beats dirty beats saved.
   */
  const RANK = { conflict: 5, error: 4, saving: 3, dirty: 2, saved: 1, idle: 0 } as const;
  const saveState: SaveState = RANK[nameState] >= RANK[purposeState] ? nameState : purposeState;

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
        options: fieldHasOptions(newType) ? newOptions : [],
        ...(newIsRating ? { scale: newScale } : {}),
        ...(newIsCurrency ? { currency: newCurrency } : {}),
      });
      setNewName('');
      setNewType('text');
      setNewOptions([]);
      setNewIsRating(false);
      setNewScale({ max: 5, step: 0.5 });
      setNewIsCurrency(false);
      setNewCurrency(DEFAULT_CURRENCY);
    });
  }

  /** Deletes the whole notebook; `trashNotes` decides whether its notes go with it. */
  function deleteNotebook(trashNotes: boolean) {
    void run(async () => {
      await api.deleteNotebook(notebookId, { trashNotes });
      setConfirmingDelete(false);
      // The list this returns to no longer holds this notebook; leave before it refetches.
      onDeleted();
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
   *
   * `currency` is the same for the "Currency" entry, with one difference: a currency is
   * display only, so a number gaining or losing one clears nothing, and when that is all
   * that changes there is nothing to preview and it writes at once.
   */
  async function changeType(
    field: FieldDef,
    to: FieldType,
    scale?: FieldScale | null,
    currency?: string | null,
  ) {
    const scaleChanged = scale !== undefined && (scale === null) !== (field.scale === null);
    const currencyChanged = currency !== undefined && (currency ?? null) !== (field.currency ?? null);
    if (to === field.type && !scaleChanged && !currencyChanged) return;
    setError(null);
    if (to === field.type && !scaleChanged) {
      void run(() => api.updateNotebookField(notebookId, field.id, { currency: currency ?? null }));
      return;
    }
    try {
      const preview = await api.previewFieldConversion(notebookId, field.id, to, scale);
      if (preview.incompatible > 0) {
        setPendingType({ field, to, scale, currency, ...preview });
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
        ...(currency !== undefined ? { currency } : {}),
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
    const { field, to, scale, currency } = pending;
    void run(async () => {
      await api.updateNotebookField(notebookId, field.id, {
        // A scale tighten is not a type change, and `changeScale` writes it without a
        // `type`. Sending one here anyway is a no-op server-side, but it would make the
        // two paths for one intent send different bodies.
        ...(scaleOnlyConfirm(pending) ? {} : { type: to }),
        ...(scale !== undefined ? { scale } : {}),
        ...(currency !== undefined ? { currency } : {}),
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

  /**
   * Applies an edit to a select's or multi-select's options.
   *
   * Every edit but one writes straight through: adding an option, renaming one, reordering
   * them — none can strand a value. The exception is removing an option that notes still
   * hold. That is the one option edit that can orphan data, so it is the one that asks
   * first: the field's own value keeps working (it shows as "no longer an option"), but
   * whether those notes should lose it is the person's call, not a silent effect of tidying
   * the list. When more than one option leaves at once — a rare multi-remove — it is not
   * worth a prompt per option; the whole edit writes through, matching how the list behaved
   * before this guard existed and never destroying a value without a single removal's intent.
   */
  function editOptions(field: FieldDef, options: string[]) {
    const removed = field.options.filter((o) => !options.includes(o));
    if (removed.length === 1) {
      const option = removed[0]!;
      void run(async () => {
        const usage = await api.countOptionUsage(notebookId, field.id, option);
        if (usage > 0) {
          setPendingOption({ field, option, usage });
          return;
        }
        await api.removeNotebookFieldOption(notebookId, field.id, option, false);
      });
      return;
    }
    void run(() => api.updateNotebookField(notebookId, field.id, { options }));
  }

  /** Carries out a confirmed option removal: `clear` decides the notes' fate. */
  function confirmRemoveOption(clear: boolean) {
    if (!pendingOption) return;
    const { field, option } = pendingOption;
    void run(async () => {
      await api.removeNotebookFieldOption(notebookId, field.id, option, clear);
      setPendingOption(null);
    });
  }

  /**
   * Optimistic, like `move`: the emoji shows in the square, and in the drawer behind this
   * page, the moment it is picked, and is written behind it. `run` refetches the list on
   * success; on failure the refetch here puts back what the server still has.
   */
  function changeEmoji(emoji: string | null) {
    queryClient.setQueryData(keys.notebooks(), (list: api.NotebookList | undefined) =>
      list && {
        ...list,
        notebooks: list.notebooks.map((nb) => (nb.id === notebookId ? { ...nb, emoji } : nb)),
      },
    );
    void run(async () => {
      try {
        await api.updateNotebook(notebookId, { emoji });
      } catch (err) {
        void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
        throw err;
      }
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
      keys.notebookFieldCounts(notebookId),
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
    <div className="panel notebook-edit">
      <div className="panel-head">
        <h2>{notebook ? `Edit ${notebook.name}` : 'Edit notebook'}</h2>
        <div className="notebook-head-actions">
          {/* The name and purpose autosave; this says so in the note editor's own words, so
              the two pages read alike. Blank while idle, so it appears only once there is
              something to report. */}
          <span
            className={`workspace-status ${saveState === 'error' ? 'bad' : 'muted'} small`}
            aria-live="polite"
          >
            {SAVE_LABEL[saveState]}
          </span>
          <Link to="/settings/notebooks" className="link small">
            All notebooks
          </Link>
        </div>
      </div>

      {/* The page is three sections — the notebook itself, its fields, its deletion — and the
          spacing lives on them rather than on what is inside: see `.notebook-edit`. */}
      <section className="notebook-section">
        {/* A failed field operation, or a failed name/purpose autosave (a clash, most often),
            shown in full under the header where the indicator only had room for "Save failed". */}
        {(error ?? nameError ?? purposeError) && (
          <p className="bad small">{error ?? nameError ?? purposeError}</p>
        )}

        {/* The name comes first — it is what the notebook is called, and what the list showed.
            Renaming here updates every note in it, because the notes reference the id. It
            autosaves as you type, and is flushed if you leave the page mid-edit.

            The emoji leads the name the way it leads it in the drawer, so the row reads as
            the notebook does everywhere else: picture, then words. */}
        <div className="notebook-name-edit">
          <label className="notebook-purpose-label" htmlFor="notebook-name">
            Name
          </label>
          <div className="notebook-name-row">
            <EmojiField
              emoji={notebook?.emoji ?? null}
              name={notebook?.name ?? 'this notebook'}
              // Not disabled while a save is in flight, unlike the fields around it: the
              // picker hands focus back to this square as it closes, and a square disabled
              // by the save that close starts would drop that focus on the floor.
              disabled={!notebook}
              onChange={changeEmoji}
            />
            <input
              id="notebook-name"
              className="search-field"
              value={nameDraft ?? ''}
              disabled={busy || !notebook}
              aria-label="Notebook name"
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter commits now rather than waiting out the debounce; Escape abandons the
                // edit back to the saved name.
                if (e.key === 'Enter') void flushName();
                if (e.key === 'Escape') setNameDraft(savedName);
              }}
            />
          </div>
        </div>

        {/* The notebook's purpose sits above its fields because it is about the notebook as a
            whole, not about any one field. It is optional and empty by default; what it earns
            its place for is auto-fill, which reads it to decide whether a note belongs here —
            so the placeholder coaches toward what belongs and, as usefully, what does not. */}
        <div className="notebook-purpose">
          <label className="notebook-purpose-label" htmlFor="notebook-purpose">
            Purpose <span className="muted small">— optional</span>
          </label>
          <textarea
            id="notebook-purpose"
            className="notebook-purpose-input"
            value={purposeDraft ?? ''}
            rows={2}
            maxLength={MAX_NOTEBOOK_PURPOSE_LENGTH}
            disabled={busy || !notebook}
            placeholder="What belongs here — and what doesn't. e.g. Things I want to buy someday; not receipts or purchases."
            onChange={(e) => setPurposeDraft(e.target.value)}
          />
          <p className="muted small notebook-purpose-hint">
            Auto-fill reads this when it decides where a note belongs, so a notebook whose name
            could mislead — a “Shopping” list that is really a wish list — keeps notes that
            don't fit out.
          </p>
        </div>
      </section>

      <section className="notebook-section">
        <h3 className="notebook-section-head">Fields</h3>

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
                  <FieldTypeIcon type={field.type} rating={isRatingField(field)} currency={isCurrencyField(field)} />
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
                  value={isRatingField(field) ? 'rating' : isCurrencyField(field) ? 'currency' : field.type}
                  disabled={busy}
                  onChange={(e) => {
                    const picked = e.target.value;
                    // Away from a rating, the scale goes with it; away from an amount, the
                    // currency does — `null` rather than undefined, which would leave the old
                    // one on the field.
                    const dropScale = field.scale ? null : undefined;
                    const dropCurrency = field.currency ? null : undefined;
                    if (picked === 'rating') {
                      // Turning a number into a rating: the scale it starts on is the one
                      // the create form offers, which is the shape most ratings want.
                      void changeType(field, 'number', { max: 5, step: 0.5 }, dropCurrency);
                    } else if (picked === 'currency') {
                      void changeType(field, 'number', dropScale, DEFAULT_CURRENCY);
                    } else {
                      void changeType(field, picked as FieldType, dropScale, dropCurrency);
                    }
                  }}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FIELD_TYPE_LABELS[t]}
                    </option>
                  ))}
                  <option value="rating">Rating</option>
                  <option value="currency">Currency</option>
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

              {fieldHasOptions(field.type) && (
                <div className="field-admin-options">
                  <TagInput
                    label="option"
                    tags={field.options}
                    suggestions={[]}
                    reorderable
                    onChange={(options) => editOptions(field, options)}
                  />
                  {/* The removal confirm floats over the rows below rather than pushing them,
                      and sits under the option it is about so the two read as one action. */}
                  {pendingOption?.field.id === field.id && (
                    <div className="field-option-confirm" ref={optionConfirmRef}>
                      <Confirm
                        label="Confirm remove option"
                        question={
                          <>
                            Remove <strong>{pendingOption.option}</strong> from {field.name}?
                          </>
                        }
                        detail={
                          `${plural(pendingOption.usage, 'note')} still ${pendingOption.usage === 1 ? 'uses' : 'use'} it. ` +
                          'Keep it and those notes still show it, marked no longer an option; clear it and ' +
                          `it's removed from ${pendingOption.usage === 1 ? 'that note' : 'those notes'}.`
                        }
                        busy={busy}
                        onCancel={() => setPendingOption(null)}
                        actions={[
                          {
                            label: 'Keep values',
                            busyLabel: 'Removing…',
                            // Filled in ink, not the brand green, so it does not clash with the red clear.
                            tone: 'neutral',
                            onConfirm: () => confirmRemoveOption(false),
                          },
                          {
                            label: `Clear from ${plural(pendingOption.usage, 'note')}`,
                            busyLabel: 'Clearing…',
                            tone: 'danger',
                            onConfirm: () => confirmRemoveOption(true),
                          },
                        ]}
                      />
                    </div>
                  )}
                </div>
              )}

              {isRatingField(field) && field.scale && (
                <ScalePicker
                  scale={field.scale}
                  disabled={busy}
                  onChange={(scale) => void changeScale(field, scale)}
                />
              )}

              {isCurrencyField(field) && field.currency && (
                <CurrencyPicker
                  currency={field.currency}
                  disabled={busy}
                  onChange={(currency) =>
                    void run(() => api.updateNotebookField(notebookId, field.id, { currency }))
                  }
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
                    {pendingType.scale
                      ? 'Rating'
                      : pendingType.currency
                        ? 'Currency'
                        : FIELD_TYPE_LABELS[pendingType.to]}
                    ?
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
              value={newIsRating ? 'rating' : newIsCurrency ? 'currency' : newType}
              disabled={busy}
              onChange={(e) => {
                const picked = e.target.value;
                setNewIsRating(picked === 'rating');
                setNewIsCurrency(picked === 'currency');
                setNewType(picked === 'rating' || picked === 'currency' ? 'number' : (picked as FieldType));
              }}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
              {/* Last, and named for what they are rather than for what they store. */}
              <option value="rating">Rating</option>
              <option value="currency">Currency</option>
            </select>
          </span>
          <span className="field-admin-add">
            <Button variant="primary" disabled={busy || !newName.trim()} onClick={create}>
              Add field
            </Button>
          </span>
          {fieldHasOptions(newType) && !newIsRating && (
            <TagInput
              label="option"
              tags={newOptions}
              suggestions={[]}
              reorderable
              onChange={setNewOptions}
            />
          )}
          {newIsRating && (
            <ScalePicker scale={newScale} disabled={busy} onChange={setNewScale} />
          )}
          {newIsCurrency && (
            <CurrencyPicker currency={newCurrency} disabled={busy} onChange={setNewCurrency} />
          )}
        </div>

        <p className="muted small">
          Fields appear on every note in this notebook. Deleting a field deletes its values.
          Changing a field's type, or narrowing a rating's scale, clears any value that can't
          be read that way. A note moved to another notebook keeps the values it has.
        </p>
      </section>

      {/* Delete sits last and apart, the way a destructive action should: past the fields,
          under its own heading, not a button a stray click on the way down the page can find.
          The list offers the same delete, so this is a second door, not the only one.

          The heading is in the page's ink like "Fields", and the red is the button's alone.
          Both were red once, with the button `quiet` and so borderless: two lines of the
          same red words, one of which you could click, and nothing to say which. The button
          is outlined because it appears once on the page — `quiet` is for actions repeated
          down a dense list, and here it only made the one action look like a caption. */}
      <section className="notebook-section">
        <h3 className="notebook-section-head">Delete notebook</h3>
        <p className="muted small">
          Deleting <strong>{notebook?.name}</strong> leaves its notes unfiled unless you choose
          to move them to Trash.
        </p>
        <Button
          variant="secondary"
          tone="danger"
          disabled={busy || !notebook}
          onClick={() => setConfirmingDelete(true)}
        >
          Delete notebook
        </Button>

        {confirmingDelete && notebook && (
          <DeleteNotebookConfirm
            name={notebook.name}
            count={notebook.count}
            busy={busy}
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={deleteNotebook}
          />
        )}
      </section>
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

/**
 * An amount's currency: one select over the common codes, with the field's own code first
 * when it is not among them — a code set over the API or read from a definitions file is
 * still a choice here, not a blank. A currency is display only, so every change writes at
 * once; the line under the select is how a value will draw, in the viewer's locale.
 */
function CurrencyPicker({
  currency,
  disabled,
  onChange,
}: {
  currency: string;
  disabled?: boolean;
  onChange: (currency: string) => void;
}) {
  const codes: string[] = (CURRENCY_CODES as readonly string[]).includes(currency)
    ? [...CURRENCY_CODES]
    : [currency, ...CURRENCY_CODES];
  return (
    <div className="field-admin-scale">
      <label className="notebook-scope-wrap">
        <span className="muted small">Currency</span>
        <select
          className="notebook-scope"
          aria-label="Currency"
          value={currency}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <span className="muted small">Shown as {formatCurrency(1234.5, currency)}.</span>
    </div>
  );
}
