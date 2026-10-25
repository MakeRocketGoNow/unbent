import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CURRENCY_CODES,
  DEFAULT_RATING_SCALE,
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  MAX_NOTEBOOK_PURPOSE_LENGTH,
  MAX_RATING_MAX,
  MIN_RATING_MAX,
  notebookNameSchema,
  assignOptionColors,
  compareOptions,
  fieldHasOptions,
  fieldNameSchema,
  isCurrencyField,
  isRatingField,
  type FieldDef,
  type FieldScale,
  type FieldType,
  type NotebookView,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { SAVE_LABEL, useAutosave, type SaveState } from '../useAutosave.js';
import { keys, notebookFieldCountsQuery, notebooksQuery, viewsQuery } from '../queries.js';
import * as actions from '../store/actions.js';
import { Button } from './Button';
import { Confirm } from './Confirm.js';
import { DeleteNotebookConfirm } from './DeleteNotebookConfirm.js';
import { EmojiField } from './EmojiField.js';
import { KeepOffline } from './KeepOffline.js';
import { TagInput } from './TagInput.js';
import { formatCurrency } from './format-field.js';
import { FieldTypeIcon, MoveDownIcon, MoveUpIcon, ViewRowIcon } from './icons.js';
import { ViewNameField } from './ViewName.js';

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
  /**
   * Set when `scale` is the one the server read from the field's values rather than one
   * the person picked: a field becoming a rating. The confirmation then names that scale
   * and says what it keeps, not only what it clears.
   */
  fitted?: boolean;
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

/**
 * A rename onto an option that already exists, held while the person decides: the two
 * would become one, and afterwards nothing tells which notes held which. `usage` is how
 * many notes hold `from`, the ones that would move.
 */
interface PendingMerge {
  field: FieldDef;
  from: string;
  to: string;
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
 * read and clears the rest. Tightening a rating's scale does the same: a 7 cannot stay
 * on a 5-point scale, and a 3.5 cannot stay once half steps are dropped. In both of those
 * the server is asked what would be cleared before anything is written, so the confirmation
 * carries the real number rather than a warning in the abstract. Becoming a select never
 * loses anything: the existing values become the options. Widening a scale never loses
 * anything either, and writes without asking.
 *
 * Order is set with two buttons rather than drag, for the fields here and for a select's
 * options alike. A dozen fields is the realistic maximum, two buttons work with a keyboard
 * and on a phone, and drag-to-reorder is a component this codebase does not have yet. The
 * list items say the same (see docs/editor.md). The fields are a column and move up/down; a
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
   * the saved value changes under it, but otherwise left to the person's keystrokes: a
   * controlled textarea bound straight to the query would fight the caret on every refetch.
   */
  const [purposeDraft, setPurposeDraft] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FieldDef | null>(null);
  const [pendingType, setPendingType] = useState<PendingType | null>(null);
  const [pendingOption, setPendingOption] = useState<PendingOption | null>(null);
  const [pendingMerge, setPendingMerge] = useState<PendingMerge | null>(null);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<FieldType>('text');
  const [newOptions, setNewOptions] = useState<string[]>([]);
  /*
     "Rating" is a choice in the type picker, but not a field type: it is a `number` that
     carries a scale. The picker is where a person looks for it (nobody adding a star
     rating goes looking for "Number" and then a scale) so the kind is held here and
     turned back into a type and a scale at the moment the field is created.
  */
  const [newIsRating, setNewIsRating] = useState(false);
  const [newScale, setNewScale] = useState<FieldScale>(DEFAULT_RATING_SCALE);
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
     and reopen in one gesture, but that button is disabled by `busy` during the run and is
     never what dismisses, so a plain contains-check is enough.

     A layout effect, not a passive one, so the listener exists the instant the popover is
     in the DOM. The popover opens from a promise continuation (after the usage count comes
     back), which React commits on its scheduler rather than inside an event, and it then
     flushes passive effects in a later task. That leaves a moment where the popover is
     visible but a pointer down outside it does nothing. No person can click inside it, but
     the test that pins this behaviour can: `waitFor` sees the popover as soon as it is
     committed and fires the pointer down before that later task has run, reliably on a
     slow CI runner, where the timer Testing Library drains with fires before React's task.
  */
  const optionConfirmRef = useRef<HTMLDivElement>(null);
  // The merge confirm floats in the same place and dismisses the same way.
  const optionPopoverOpen = pendingOption !== null || pendingMerge !== null;
  useLayoutEffect(() => {
    if (!optionPopoverOpen || busy) return;
    const onDown = (e: PointerEvent) => {
      if (optionConfirmRef.current?.contains(e.target as Node)) return;
      setPendingOption(null);
      setPendingMerge(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [optionPopoverOpen, busy]);

  // Seed the name and purpose drafts into the controlled inputs from the notebook, and
  // follow the saved values when they change under us (another tab, a fresh load), but only
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
   * Name and purpose autosave the way a note's body does: debounced as you type, and (the
   * reason it is the hook and not a blur handler) flushed on unmount and on tab hide, so
   * clicking a nav link or closing the tab mid-edit still saves the last change rather than
   * dropping it. Only enabled once the draft is seeded from the notebook, so the seed itself
   * is never mistaken for an edit (the same guard the note editor relies on).
   */
  const seeded = notebook !== undefined && nameDraft !== null && purposeDraft !== null;

  /**
   * Saves the name when it is a real, valid change. An empty or unseeded draft, or one equal
   * to the saved name, is `'unchanged'`: the hook's honest no-op, so a name typed back to
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
      setNewScale(DEFAULT_RATING_SCALE);
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
   * because the type has not changed yet: the confirmation is what changes it.
   *
   * `scale` is what the picker's "Rating" and "Number" entries differ by: both are the
   * `number` type, so a switch between them is a scale arriving or going away rather than
   * a type change. It still goes through the preview, because gaining a scale can clear
   * values (a stored 0 or 250 is no longer a legal rating) and that is exactly the
   * confirmation a type change gets.
   *
   * `'fit'` is how "Rating" asks for that scale: the server reads it from the values the
   * field holds (`fitRatingScale`), so scores out of 10 become a rating out of 10 rather
   * than five stars that clear every 6 and up (MAK-80). Because the scale was chosen for
   * the person, a field with values always stops to say which one it is and what it
   * keeps, even when nothing is cleared, where the confirmation is the green kind.
   *
   * `currency` is the same for the "Currency" entry, with one difference: a currency is
   * display only, so a number gaining or losing one clears nothing, and when that is all
   * that changes there is nothing to preview and it writes at once.
   */
  async function changeType(
    field: FieldDef,
    to: FieldType,
    scaleAsked?: FieldScale | null | 'fit',
    currency?: string | null,
  ) {
    const fitted = scaleAsked === 'fit';
    let scale = fitted ? undefined : scaleAsked;
    const scaleChanged = scaleAsked !== undefined && (scaleAsked === null) !== (field.scale === null);
    const currencyChanged = currency !== undefined && (currency ?? null) !== (field.currency ?? null);
    if (to === field.type && !scaleChanged && !currencyChanged) return;
    setError(null);
    if (to === field.type && !scaleChanged) {
      void run(() => api.updateNotebookField(notebookId, field.id, { currency: currency ?? null }));
      return;
    }
    try {
      const preview = await api.previewFieldConversion(notebookId, field.id, to, scaleAsked);
      if (fitted) scale = preview.scale;
      if (preview.incompatible > 0 || (fitted && preview.values > 0)) {
        setPendingType({ field, to, currency, ...preview, scale, fitted });
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
   * be cleared (widening 5 to 10, or narrowing past values nobody used) and only stop
   * for confirmation when the server names a count.
   *
   * Both controls stay on the current scale while that confirmation is open, the select
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
        setPendingType({ field, to: field.type, ...preview, scale });
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
   * Applies an edit to a select's or multi-select's options: an addition, a removal or a
   * new order, as the chip list reports them: the whole list, which is all it knows.
   *
   * A rename is not one of these. Through the whole list it was a removal and an addition,
   * which left the notes holding the old name on a value the field no longer offered;
   * `renameOption` sends it as a rename instead, and the notes move with it.
   *
   * Adding and reordering write straight through, as a `replace` edit on the same route
   * the rename uses, since neither can strand a value. The exception is removing an option
   * that notes still hold. That is the one option edit here that can orphan data, so it is
   * the one that asks first: the field's own value keeps working (it shows as "no longer
   * an option"), but whether those notes should lose it is the person's call, not a silent
   * effect of tidying the list. When more than one option leaves at once (a rare multi-remove) it is not
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
    void run(() => api.editNotebookFieldOptions(notebookId, field.id, { replace: options }));
  }

  /**
   * Renames an option, moving every note that holds it (MAK-227's `editFieldOptions`,
   * through its route). Resolves whether the rename was applied, which is what tells the
   * chip to keep showing the new name until the list catches up.
   *
   * A rename onto an option that already stands is a merge, which cannot be taken apart
   * again, so it is not sent: the person is asked first, with both names and the number
   * of notes that would move, and only their yes sends `merge`. Names compare exactly, as
   * options do everywhere: "grocery" beside "Grocery" is a rename, not a merge.
   */
  async function renameOption(field: FieldDef, from: string, to: string): Promise<boolean> {
    let applied = false;
    setPendingOption(null);
    setPendingMerge(null);
    await run(async () => {
      if (field.options.includes(to)) {
        const usage = await api.countOptionUsage(notebookId, field.id, from);
        setPendingMerge({ field, from, to, usage });
        return;
      }
      await api.editNotebookFieldOptions(notebookId, field.id, { rename: [{ from, to }] });
      applied = true;
    });
    return applied;
  }

  function confirmMerge() {
    if (!pendingMerge) return;
    const { field, from, to } = pendingMerge;
    void run(async () => {
      await api.editNotebookFieldOptions(notebookId, field.id, { rename: [{ from, to }], merge: true });
      setPendingMerge(null);
    });
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

  /**
   * The order the person last chose, held until the library agrees with it.
   *
   * Writing the move into the query cache was not enough: the fields here are read from
   * the device's library, which learns the new order only when the change feed brings it,
   * a beat after the request. `run`'s refetch in between read the old order back, so the
   * rows jumped back and then forward again. The order is held here instead, over
   * whatever the query answers, and let go once an answer has it, or once the write
   * fails, when the next answer is what the server still has.
   */
  const [heldOrder, setHeldOrder] = useState<string[] | null>(null);
  const answered = fields.data ?? [];
  const list = heldOrder ? inOrder(answered, heldOrder) : answered;

  useEffect(() => {
    if (heldOrder && sameOrder(answered, heldOrder)) setHeldOrder(null);
  }, [answered, heldOrder]);

  /** Optimistic: the row moves now, and the order is written behind it. */
  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target]!, next[index]!];
    const ids = next.map((f) => f.id);
    setHeldOrder(ids);
    void run(async () => {
      try {
        await api.reorderNotebookFields(notebookId, ids);
      } catch (err) {
        setHeldOrder(null);
        throw err;
      }
    });
  }

  /*
   * The notebook's saved views, in their order, with the same held-order rule the fields
   * use: a move is a request, and the library learns the new positions from the feed a
   * beat later, so the order asked for is held over the answer until the answer has it.
   */
  const allViews = useQuery(viewsQuery());
  const answeredViews = (allViews.data ?? []).filter((v) => v.notebookId === notebookId);
  const [heldViewOrder, setHeldViewOrder] = useState<string[] | null>(null);
  const viewList = heldViewOrder ? inOrder(answeredViews, heldViewOrder) : answeredViews;
  const viewIds = answeredViews.map((v) => v.id).join(',');
  useEffect(() => {
    if (heldViewOrder && sameOrder(answeredViews, heldViewOrder)) setHeldViewOrder(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewIds, heldViewOrder]);
  const [renamingView, setRenamingView] = useState<string | null>(null);
  const [pendingViewDelete, setPendingViewDelete] = useState<NotebookView | null>(null);

  /** A view's row moves one place; the store shifts its neighbours to make room. */
  function moveView(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= viewList.length) return;
    const next = [...viewList];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setHeldViewOrder(next.map((v) => v.id));
    void run(async () => {
      try {
        await actions.updateView(viewList[index]!.id, { position: target });
      } catch (err) {
        setHeldViewOrder(null);
        throw err;
      }
    });
  }

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

      {/* The page is three sections (the notebook itself, its fields, its deletion) and the
          spacing lives on them rather than on what is inside: see `.notebook-edit`. */}
      <section className="notebook-section">
        {/* A failed field operation, or a failed name/purpose autosave (a clash, most often),
            shown in full under the header where the indicator only had room for "Save failed". */}
        {(error ?? nameError ?? purposeError) && (
          <p className="bad small">{error ?? nameError ?? purposeError}</p>
        )}

        {/* The name comes first: it is what the notebook is called, and what the list showed.
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
            its place for is auto-fill, which reads it to decide whether a note belongs here,
            so the placeholder coaches toward what belongs and, as usefully, what does not. */}
        <div className="notebook-purpose">
          <label className="notebook-purpose-label" htmlFor="notebook-purpose">
            Purpose <span className="muted small">(optional)</span>
          </label>
          <textarea
            id="notebook-purpose"
            className="notebook-purpose-input"
            value={purposeDraft ?? ''}
            rows={2}
            maxLength={MAX_NOTEBOOK_PURPOSE_LENGTH}
            disabled={busy || !notebook}
            placeholder="What belongs here, and what doesn't. e.g. Things I want to buy someday; not receipts or purchases."
            onChange={(e) => setPurposeDraft(e.target.value)}
          />
          <p className="muted small notebook-purpose-hint">
            Auto-fill reads this when it decides where a note belongs, so a notebook whose name
            could mislead (a “Shopping” list that is really a wish list) keeps notes that
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
                  data-tip="Rename"
                  onClick={() => setEditing({ id: field.id, value: field.name })}
                >
                  <FieldTypeIcon type={field.type} rating={isRatingField(field)} currency={isCurrencyField(field)} />
                  {field.name}
                  {field.valueCount !== undefined && field.valueCount > 0 && (
                    <span className="tag-count" data-tip={`${plural(field.valueCount, 'note')} with a value`}>
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
                    // currency does: `null` rather than undefined, which would leave the old
                    // one on the field.
                    const dropScale = field.scale ? null : undefined;
                    const dropCurrency = field.currency ? null : undefined;
                    if (picked === 'rating') {
                      // Turning a field into a rating: the scale it starts on is read from
                      // the values it holds, and is the create form's when it holds none.
                      void changeType(field, 'number', 'fit', dropCurrency);
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
                  data-tip="Move up"
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <MoveUpIcon />
                </Button>
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={`Move ${field.name} down`}
                  data-tip="Move down"
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
                    caseless={false}
                    tags={field.options}
                    suggestions={[]}
                    reorderable
                    colorOf={(o) => field.optionColors?.[o] ?? null}
                    onChange={(options) => editOptions(field, options)}
                    onRename={(from, to) => renameOption(field, from, to)}
                    onRecolor={(option, color) =>
                      void run(() => api.updateNotebookField(notebookId, field.id, { optionColors: { [option]: color } }))
                    }
                    trailing={
                      // Faded rather than gone once the list is in order, so the row does
                      // not change shape after a press.
                      field.options.length > 1 && (
                        <Button
                          variant="quiet"
                          size="small"
                          disabled={busy || isSorted(field.options)}
                          tip={isSorted(field.options) ? 'Already in A–Z order' : undefined}
                          onClick={() =>
                            void run(() => api.editNotebookFieldOptions(notebookId, field.id, { sort: 'alpha' }))
                          }
                        >
                          Sort A–Z
                        </Button>
                      )
                    }
                  />
                  {/* The removal confirm floats over the rows below rather than pushing them,
                      and sits under the option it is about so the two read as one action. */}
                  {pendingMerge?.field.id === field.id && (
                    <div className="field-option-confirm" ref={optionConfirmRef}>
                      <Confirm
                        label="Confirm merge options"
                        question={
                          <>
                            Merge <strong>{pendingMerge.from}</strong> into <strong>{pendingMerge.to}</strong>?
                          </>
                        }
                        detail={
                          (pendingMerge.usage === 0
                            ? `No note uses ${pendingMerge.from}, so it only leaves the list.`
                            : `${plural(pendingMerge.usage, 'note')} with ${pendingMerge.from} will show ` +
                              `${pendingMerge.to} instead, and ${pendingMerge.from} leaves the list. `) +
                          (pendingMerge.usage === 0 ? '' : "The two can't be told apart afterwards.")
                        }
                        busy={busy}
                        // The field the rename was typed in is gone by now, so focus would
                        // otherwise be on the page; Cancel is the safe place to land.
                        focusCancel
                        onCancel={() => setPendingMerge(null)}
                        actions={[
                          { label: 'Merge', busyLabel: 'Merging…', tone: 'primary', onConfirm: confirmMerge },
                        ]}
                      />
                    </div>
                  )}
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
                  pendingType.fitted && pendingType.scale ? (
                    <>
                      Change <strong>{pendingType.field.name}</strong> to a rating out of{' '}
                      {pendingType.scale.max}?
                    </>
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
                  )
                )}
              </>
            }
            detail={conversionDetail(pendingType)}
            busy={busy}
            onCancel={() => setPendingType(null)}
            actions={[
              // Only a fitted rating stops with nothing to clear; any other confirm that
              // ever does must not borrow this label.
              pendingType.fitted && pendingType.incompatible === 0
                ? { label: 'Change to rating', busyLabel: 'Changing…', tone: 'primary', onConfirm: confirmType }
                : {
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
              caseless={false}
              tags={newOptions}
              suggestions={[]}
              reorderable
              // The colours the server will give them, by its own rule, so the chips
              // here are the chips the field will have.
              colorOf={(o) => assignOptionColors(newOptions, null)[o] ?? null}
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
          be read that way. A field becoming a rating is scaled to fit the numbers it already
          holds, up to 10. A note moved to another notebook keeps the values it has.
        </p>
      </section>

      {/*
          The notebook's saved views: their order in the rail, their names, and the way to
          delete one. Between the fields and Keep offline, since a view is made of the
          fields' filters and is part of what the notebook is, where keeping it offline is
          about this device. Made from the list rather than here: a view is the list the
          way someone left it, and this page has no list to leave.

          The name renames, as a field's does; Delete confirms, naming the view, and says
          the notes stay. The arrows are the fields' arrows, for the fields' reasons.
      */}
      <section className="notebook-section">
        <h3 className="notebook-section-head">Views</h3>

        <ul className="notebook-admin view-admin">
          {viewList.map((v, index) => (
            <li key={v.id}>
              {renamingView === v.id ? (
                <ViewNameField
                  initial={v.name}
                  label={`New name for ${v.name}`}
                  commitLabel="Rename"
                  className="view-admin-rename"
                  onCommit={async (name) => {
                    await actions.updateView(v.id, { name });
                    setRenamingView(null);
                    onChanged();
                  }}
                  onCancel={() => setRenamingView(null)}
                />
              ) : (
                <button
                  type="button"
                  className="notebook-admin-name"
                  data-tip="Rename"
                  disabled={busy}
                  onClick={() => {
                    setPendingViewDelete(null);
                    setRenamingView(v.id);
                  }}
                >
                  <ViewRowIcon />
                  <span className="view-admin-name" title={v.name}>
                    {v.name}
                  </span>
                </button>
              )}

              {renamingView !== v.id && (
                <span className="notebook-admin-actions">
                  <Button
                    variant="quiet"
                    size="small"
                    aria-label={`Move ${v.name} up`}
                    data-tip="Move up"
                    disabled={busy || index === 0}
                    onClick={() => moveView(index, -1)}
                  >
                    <MoveUpIcon />
                  </Button>
                  <Button
                    variant="quiet"
                    size="small"
                    aria-label={`Move ${v.name} down`}
                    data-tip="Move down"
                    disabled={busy || index === viewList.length - 1}
                    onClick={() => moveView(index, 1)}
                  >
                    <MoveDownIcon />
                  </Button>
                  <Button
                    variant="quiet"
                    tone="danger"
                    size="small"
                    aria-label={`Delete ${v.name}`}
                    disabled={busy}
                    onClick={() => {
                      setRenamingView(null);
                      setPendingViewDelete(v);
                    }}
                  >
                    Delete
                  </Button>
                </span>
              )}
            </li>
          ))}

          {viewList.length === 0 && allViews.isSuccess && (
            <li className="muted small">No views yet. Save one from the notebook's list.</li>
          )}
        </ul>

        {pendingViewDelete && (
          <Confirm
            label="Confirm delete view"
            question={`Delete the view “${pendingViewDelete.name}”?`}
            detail="Its notes stay where they are."
            busy={busy}
            onCancel={() => setPendingViewDelete(null)}
            actions={[
              {
                label: 'Delete view',
                busyLabel: 'Deleting…',
                tone: 'danger',
                onConfirm: () =>
                  run(async () => {
                    await actions.deleteView(pendingViewDelete.id);
                    setPendingViewDelete(null);
                  }),
              },
            ]}
          />
        )}
      </section>

      {/* Between the fields and the deletion: it is about this notebook on this device, not
          about what the notebook is, so it comes after everything that is, and before the
          one section nobody should pass on the way to another. Draws nothing where files
          cannot be kept. */}
      {notebook && <KeepOffline notebookId={notebookId} name={notebook.name} />}

      {/* Delete sits last and apart, the way a destructive action should: past the fields,
          under its own heading, not a button a stray click on the way down the page can find.
          The list offers the same delete, so this is a second door, not the only one.

          The heading is in the page's ink like "Fields", and the red is the button's alone.
          Both were red once, with the button `quiet` and so borderless: two lines of the
          same red words, one of which you could click, and nothing to say which. The button
          is outlined because it appears once on the page: `quiet` is for actions repeated
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
 * What a type or scale change keeps and clears, in a sentence.
 *
 * A fitted rating says what it keeps as well as what it clears, because the scale was
 * chosen for the person: "every one fits" is the reason the change is safe, and a count of
 * what survives is what makes a partial clear legible. The rest name only the casualties,
 * as they always have.
 */
function conversionDetail(pending: PendingType): string {
  const { values, incompatible } = pending;
  const head = `${plural(values, 'note')} ${values === 1 ? 'has' : 'have'} a value. `;
  if (pending.fitted && pending.scale) {
    const max = pending.scale.max;
    if (incompatible === 0) {
      return head + (values === 1
        ? `It fits a rating out of ${max}, so it keeps its number.`
        : `Every one fits a rating out of ${max}, so each keeps its number.`);
    }
    if (incompatible < values) {
      const kept = values - incompatible;
      return (
        head +
        `${kept} ${kept === 1 ? 'fits' : 'fit'} a rating out of ${max} and ${kept === 1 ? 'keeps its' : 'keep their'} number; ` +
        `${incompatible} can't be a rating from 1 to ${max} and will be cleared.`
      );
    }
    return head + (values === 1
      ? `It can't be a rating from 1 to ${MAX_RATING_MAX} and will be cleared.`
      : `None of them can be a rating from 1 to ${MAX_RATING_MAX}, so all will be cleared.`);
  }
  return (
    head +
    (incompatible === values
      ? incompatible === 1
        ? "It can't be read that way and will be cleared."
        : 'None of them can be read that way, so all will be cleared.'
      : `${incompatible} of them can't be read that way and will be cleared.`)
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
/** Whether a list of options is already in the order "Sort A–Z" would put it in. */
function isSorted(options: string[]): boolean {
  return options.every((o, i) => i === 0 || compareOptions(options[i - 1]!, o) <= 0);
}

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
 * away, so the caller previews first and confirms when the server names a count, the
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
 * when it is not among them: a code set over the API or read from a definitions file is
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

/** `fields` in the order `ids` names; a field `ids` does not name (one just added) goes last. */
function inOrder<T extends { id: string }>(fields: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return [...fields].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
}

/** Whether `fields` already stand in `ids`' order, ignoring ids no longer among them. */
function sameOrder(fields: { id: string }[], ids: string[]): boolean {
  const present = new Set(fields.map((f) => f.id));
  const wanted = ids.filter((id) => present.has(id));
  return wanted.length === fields.length && wanted.every((id, i) => fields[i]!.id === id);
}
