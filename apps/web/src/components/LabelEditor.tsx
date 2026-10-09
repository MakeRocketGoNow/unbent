import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  NotebookGlyph,
  TagIcon,
  PlusRowIcon,
  PencilIcon,
  CheckIcon,
  CancelIcon,
  TrashIcon,
} from './icons.js';

export interface LabelItem {
  id: string;
  name: string;
  /** Live notes carrying it; shown beside the name, since in an archive the number is the information. */
  count: number;
  /** A notebook's own emoji, drawn in place of the book. Tags have none. */
  emoji?: string | null;
}

interface LabelEditorProps {
  /** Which glyph the rows carry, and which words the empty state uses. */
  kind: 'notebook' | 'tag';
  /** Null while the list is still on its way; the editor says so rather than showing an empty list. */
  items: LabelItem[] | null;
  /** Set while a request is in flight; the controls wait for it. */
  busy: boolean;
  /**
   * Makes something new. Absent for tags, which exist only on a note — a tag with no note
   * would vanish from the list the moment it was made.
   */
  onCreate?: (name: string) => Promise<boolean>;
  /** Resolves true when the rename went through, which closes the row; false leaves it open to fix. */
  onRename: (item: LabelItem, name: string) => Promise<boolean>;
  /** Asks to delete. The caller confirms, since only it knows what deleting means for this kind. */
  onDelete: (item: LabelItem) => void;
  /**
   * When set, a row is a link to this destination rather than an inline rename — the whole
   * row navigates, and its name and pencil are anchors. It is how the notebook list works:
   * a notebook has a page of its own (its name, purpose, fields, delete), so the list is a
   * way in rather than a place to correct a name in passing. A tag has no such page and
   * leaves this unset, keeping the inline editor. Delete still rides on the row here — the
   * one destructive act that stays reachable without opening the page.
   */
  rowHref?: (item: LabelItem) => string;
  /** Anything else a resting row should carry between its name and its count. */
  renderExtra?: (item: LabelItem) => ReactNode;
  /**
   * A count that sits against the name rather than at the row's right edge. Given this, a
   * caller takes over the count entirely — the trailing bare number is dropped. It is how
   * the notebook list carries its note count: hard against the name, the way a field's
   * value count sits against the field name on the notebook's own page, so it is not a
   * second number stranded beside "Fields N" reading as more fields. Returning null shows
   * nothing, so an empty notebook is not a grey zero. Tags leave it unset and keep the
   * trailing number, which is the information a tag row is mostly for.
   */
  renderNameCount?: (item: LabelItem) => ReactNode;
  /** The item, if any, whose row should be in its editing state — the caller keeps it there under a confirm. */
  editingId?: string | null;
  /** The find field, offered once a list is long enough to need one. */
  findable?: boolean;
  /**
   * What the create row opens instead of going straight to a name field: the notebook
   * list's chooser of Blank and templates (`NotebookChooser`). Given `startBlank`, which
   * closes it and turns the row into the name field it always was, so Blank ends where
   * creating used to begin, and `close`, for the chooser's own way out. Its open state is
   * the caller's, because the caller opens it from outside the list: from the rail's New
   * notebook, and on an empty list.
   */
  chooser?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    render: (startBlank: () => void, close: () => void) => ReactNode;
  };
  emptyText: string;
  /** Under the list, once it has arrived. Null says nothing, for a list with nothing to describe yet. */
  hint: ReactNode;
}

/** Past this many rows a name is quicker to type than to scroll to. */
const FIND_THRESHOLD = 8;

/**
 * The editor for a list of names: notebooks, tags.
 *
 * Keep's "Edit labels" screen, which the Android notebooks screen adopted first and this
 * copies from it. A resting row is its glyph, its name, its count and a pencil. Tapping
 * it turns the row into the field in place, with a trash can where the glyph was and a
 * check where the pencil was, fenced by a rule above and below: the two things you can
 * do to a name, offered once you have said which one. Delete lives only in that state, so
 * a destructive word is not on every line of a list whose rows are mostly read, and a
 * stray click on the list cannot find it. Creating is a row at the top that becomes a
 * field the same way.
 *
 * Nothing moves when a row starts editing. The glyph and the trash can share one slot,
 * the pencil and the check share another, and the fence is laid out transparent on a
 * resting row so it costs no height when it appears — the Android screen learned both of
 * those the hard way and they are written into the CSS here from the start.
 *
 * One component for two kinds rather than two pages that drift: the difference between
 * a notebook and a tag is real — a notebook is a place and a tag an attribute — but the
 * act of correcting a name is the same act, and Evernote users arrive with hundreds of
 * each to correct. A tag list that long gets a find field; the caller decides.
 */
export function LabelEditor({
  kind,
  items,
  busy,
  onCreate,
  onRename,
  onDelete,
  rowHref,
  renderExtra,
  renderNameCount,
  editingId,
  findable = false,
  chooser,
  emptyText,
  hint,
}: LabelEditorProps) {
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [find, setFind] = useState('');

  // The caller can hold a row open — under a merge confirm, say — after this component
  // would otherwise have closed it.
  const openId = editing?.id ?? editingId ?? null;

  const noun = kind === 'notebook' ? 'notebook' : 'tag';
  const glyph = (item: LabelItem) =>
    kind === 'notebook' ? <NotebookGlyph emoji={item.emoji} /> : <TagIcon />;

  const startRename = (item: LabelItem) => {
    setCreating(null);
    chooser?.onOpenChange(false);
    setEditing({ id: item.id, value: item.name });
  };

  const startCreate = () => {
    setEditing(null);
    chooser?.onOpenChange(false);
    setCreating('');
  };

  /*
   * Open only once the list has arrived. What a chooser offers depends on what exists — a
   * template's name may be taken — and one opened from the rail's New notebook on a cold
   * load would otherwise be chosen from against a list it has not seen.
   */
  const chooserOpen = Boolean(chooser?.open) && creating === null && items !== null;

  /*
   * Asked open from outside — the rail's New notebook pressed again while Blank's name
   * field is out — the chooser wins: that press is a request to choose again, and it
   * would otherwise vanish, its `?new=1` already dropped from the address.
   */
  const askedOpen = Boolean(chooser?.open);
  useEffect(() => {
    if (askedOpen) setCreating(null);
  }, [askedOpen]);

  /*
   * Closing the chooser hands focus back to the row that opened it. Whatever held focus —
   * a card, the cross — is gone with it, and a keyboard or screen reader would otherwise
   * start again from the top of the page.
   */
  const createRef = useRef<HTMLButtonElement>(null);
  const closeChooser = () => {
    chooser?.onOpenChange(false);
    createRef.current?.focus();
  };

  const commitRename = async (item: LabelItem) => {
    const value = editing?.value.trim() ?? '';
    // A no-op rename would refuse against the name's own row; an empty one is a cancel.
    if (!value || value === item.name) {
      setEditing(null);
      return;
    }
    if (await onRename(item, value)) setEditing(null);
  };

  const commitCreate = async () => {
    const value = creating?.trim() ?? '';
    if (!value || !onCreate) return;
    if (await onCreate(value)) setCreating(null);
  };

  const shown =
    items === null
      ? []
      : find.trim()
        ? items.filter((i) => i.name.toLowerCase().includes(find.trim().toLowerCase()))
        : items;

  return (
    <div className="label-editor-wrap">
      {findable && items !== null && items.length > FIND_THRESHOLD && (
        <input
          className="search-field label-find"
          type="search"
          value={find}
          placeholder={`Find a ${noun}…`}
          aria-label={`Find a ${noun}`}
          onChange={(e) => setFind(e.target.value)}
        />
      )}

      <ul className="label-editor" aria-busy={busy || items === null || undefined}>
        {onCreate &&
          (creating !== null ? (
            <li className="label-row editing">
              {/* Leaving, not deleting: nothing exists yet, so the slot the trash can
                  takes on a real row takes a cross here. */}
              <button
                type="button"
                className="icon-btn label-slot"
                aria-label="Cancel"
                data-tip="Cancel"
                disabled={busy}
                onClick={() => setCreating(null)}
              >
                <CancelIcon />
              </button>
              <RowField
                value={creating}
                placeholder={`New ${noun} name`}
                label={`New ${noun} name`}
                disabled={busy}
                onChange={setCreating}
                onCommit={() => void commitCreate()}
                onCancel={() => setCreating(null)}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Create"
                data-tip="Create"
                disabled={busy || !creating.trim()}
                onClick={() => void commitCreate()}
              >
                <CheckIcon />
              </button>
            </li>
          ) : (
            <li className={chooserOpen ? 'label-row label-create editing' : 'label-row label-create'}>
              {/* The way out takes the plus's slot, where the creating row's own Cancel
                  sits, so the cross is in one place whether Blank has been chosen or not. */}
              {chooserOpen ? (
                <button
                  type="button"
                  className="icon-btn label-slot"
                  aria-label="Close"
                  data-tip="Close"
                  onClick={closeChooser}
                >
                  <CancelIcon />
                </button>
              ) : (
                <span className="label-slot" aria-hidden="true">
                  <PlusRowIcon />
                </span>
              )}
              {/* With a chooser the row opens it, and says so; the same row closes it. */}
              <button
                ref={createRef}
                type="button"
                className="label-name"
                disabled={busy}
                aria-expanded={chooser ? chooserOpen : undefined}
                onClick={() => {
                  if (!chooser) return startCreate();
                  setEditing(null);
                  chooser.onOpenChange(!chooserOpen);
                }}
              >
                Create new {noun}
              </button>
            </li>
          ))}

        {chooser && chooserOpen && <li className="label-chooser">{chooser.render(startCreate, closeChooser)}</li>}

        {shown.map((item) =>
          rowHref ? (
            /* A navigational row: the whole thing leads to the item's own page. The name
               is the link, the pencil beside it is the same link worn as the row's affordance
               (the same glyph the inline editor uses to say "editable"), and delete stays as
               a trash button so the one destructive act does not require opening the page.
               No editing state, so no fence and no in-place field. */
            <li key={item.id} className="label-row label-row-link">
              <span className="label-slot" aria-hidden="true">
                {glyph(item)}
              </span>
              <Link to={rowHref(item)} className="label-name label-name-link" disabled={busy}>
                <span className="label-name-text">{item.name}</span>
                {renderNameCount?.(item)}
              </Link>
              {renderExtra?.(item)}
              {!renderNameCount && <span className="tag-count">{item.count}</span>}
              <button
                type="button"
                className="icon-btn label-delete"
                aria-label={`Delete ${item.name}`}
                data-tip="Delete"
                disabled={busy}
                onClick={() => onDelete(item)}
              >
                <TrashIcon />
              </button>
              <Link
                to={rowHref(item)}
                className="icon-btn"
                aria-label={`Edit ${item.name}`}
                data-tip="Edit"
                disabled={busy}
              >
                <PencilIcon />
              </Link>
            </li>
          ) : openId === item.id ? (
            <li key={item.id} className="label-row editing">
              <button
                type="button"
                className="icon-btn label-slot"
                aria-label={`Delete ${item.name}`}
                data-tip="Delete"
                disabled={busy}
                onClick={() => onDelete(item)}
              >
                <TrashIcon />
              </button>
              <RowField
                value={editing?.value ?? item.name}
                label={`Rename ${item.name}`}
                disabled={busy}
                onChange={(value) => setEditing({ id: item.id, value })}
                onCommit={() => void commitRename(item)}
                onCancel={() => setEditing(null)}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Save"
                data-tip="Save"
                disabled={busy}
                onClick={() => void commitRename(item)}
              >
                <CheckIcon />
              </button>
            </li>
          ) : (
            <li key={item.id} className="label-row">
              <span className="label-slot" aria-hidden="true">
                {glyph(item)}
              </span>
              {/* The name is the row's target, since renaming is what the row is mostly
                  for; the pencil beside it says so, which a bare name did not. */}
              <button
                type="button"
                className="label-name"
                disabled={busy}
                onClick={() => startRename(item)}
              >
                {/* The name takes the ellipsis; a count against it keeps its width, so a
                    long name truncates before the number does. */}
                <span className="label-name-text">{item.name}</span>
                {renderNameCount?.(item)}
              </button>
              {renderExtra?.(item)}
              {/* The trailing number, unless the count moved against the name. */}
              {!renderNameCount && <span className="tag-count">{item.count}</span>}
              <button
                type="button"
                className="icon-btn"
                aria-label={`Rename ${item.name}`}
                data-tip="Rename"
                disabled={busy}
                onClick={() => startRename(item)}
              >
                <PencilIcon />
              </button>
            </li>
          ),
        )}

        {/* An open chooser on an empty list says what the list is for; "nothing yet"
            under it would be a second, emptier answer to the same question. */}
        {items !== null && items.length === 0 && !chooserOpen && (
          <li className="muted small label-empty">{emptyText}</li>
        )}
        {items !== null && items.length > 0 && shown.length === 0 && (
          <li className="muted small label-empty">Nothing matches.</li>
        )}
      </ul>

      {/* Nothing to say until the list is known: a hint under a list that has not arrived
          describes something the reader cannot see yet. */}
      {items !== null && hint && <p className="muted small">{hint}</p>}
    </div>
  );
}

/**
 * The field a row becomes.
 *
 * A bare input rather than a boxed one: the row is still the row, only now you can type
 * in it, and a box drawn around the name would make it jump into a different kind of
 * control. Focus is taken on arrival with the caret at the end, since a rename is usually
 * a correction there — and a caret at the start, where a focused input puts it, makes
 * the first keystroke land in front of the name. Enter commits and Escape leaves; a click
 * elsewhere does neither, because the check and the cross beside the field are the
 * decision, and a field that saved itself on blur would decide for a reader who only
 * meant to scroll.
 */
function RowField({
  value,
  label,
  placeholder,
  disabled,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <input
      ref={ref}
      className="label-field"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit();
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}
