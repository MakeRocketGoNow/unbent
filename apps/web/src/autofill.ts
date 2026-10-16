import { andList } from './and-list.js';
import type { AutofillSuggestion, FieldDef, FieldValue } from '@unbent/shared';
import type { NoteDraft } from './note-patch.js';

/**
 * Applying an auto-fill suggestion to the editor's draft.
 *
 * The server judges; this decides what to do with the judgement, by one rule: fill what
 * is empty without asking, and ask before replacing anything already set. A freshly
 * scanned note is unfiled and untagged and titled only by its filename: a timestamp the
 * scanner made, not a title anyone chose (see `isPlaceholderTitle`). So on the case this
 * exists for everything lands at once. A note someone has already filed, or titled by
 * hand, gets its empties filled and an offer for the rest, which is the warning the issue
 * asked for without a dialog in front of the common case.
 *
 * Into the draft rather than to the server, for the reason `open-note-fields.ts` gives
 * for the table's edits: the draft is what autosave writes, and a value put on the server
 * behind it would be put back by the next keystroke. Landing here also makes the fill an
 * ordinary edit: undone by retyping, saved when the note saves.
 */
export interface AutofillChanges {
  title?: string;
  notebook?: string;
  /** Tags to add. A fill never takes a tag away. */
  tags: string[];
  fields: Array<{ def: FieldDef; value: FieldValue }>;
}

export interface AutofillPlan {
  /** Fills empty slots. Applied at once. */
  fill: AutofillChanges;
  /** Would replace something already set. Applied only when asked for, and all together. */
  replace: AutofillChanges;
}

const nothing = (): AutofillChanges => ({ tags: [], fields: [] });

/**
 * A title the note carries only because something had to fill the slot, not because
 * anyone chose it, so auto-fill overwrites it like an empty one, without asking.
 *
 * Three cases: genuinely blank, the name of one of the note's own files, and the
 * timestamp a scanner leaves.
 *
 * The file name is the general rule, and the one that does the work. Every way a file
 * becomes a note names the note after it (`titleFor` here, the Android share sheet's
 * `deriveTitle`, a scanner writing straight into Evernote), and every device names its
 * files differently: ScanSnap `2026_09_18_15_38_48.pdf`, a Pixel `Scanned_20260928-2018`,
 * a camera `IMG_4012`. Matching shapes meant a new bug report per device; asking "is the
 * title just the file's name?" covers all of them, including ones not yet seen, and the
 * years of notes already imported, without recording anywhere how a title came to be.
 * It compares with or without the extension, ignoring case, since the paths differ on
 * whether they keep it.
 *
 * The cost is a file someone named by hand (`Lease renewal.pdf` titling its note "Lease
 * renewal"), which is now replaced without asking too. Accepted: that is rare in a
 * paperless archive, where the device names nearly every file, the suggested title is
 * usually the better one anyway, and the snackbar's Undo puts it back in one press. A
 * title that differs from every file name, however little, is still someone's and still
 * asks.
 *
 * The timestamp stays as a second net for a note whose file was since renamed or
 * removed, so its title no longer matches anything attached. `launch-files.ts`
 * names a scanned note after its file, and a ScanSnap file is `2026_09_18_15_38_48.pdf`,
 * which lands as the title `2026_09_18_15_38_48`. We match that shape (a full
 * `YYYY_MM_DD_HH_MM_SS`, and the same date with a `-` separator or without the time)
 * and nothing looser: the whole string must be the stamp, with real month/day/hour
 * ranges, so a title someone typed that merely opens with a year ("2026 tax plan") is
 * left alone and still prompts before it is replaced.
 *
 * The stamp may keep its file extension. `titleFor` strips it, but a note that arrived
 * any other way (years of scans imported from Evernote, which titled a scanned note
 * after the whole file name) reads `2026_09_18_15_38_48.pdf`, and the first version of
 * this, which anchored on the bare stamp, asked before replacing every one of them. The
 * extension is allowed only after a complete stamp, so it widens nothing else.
 */
export function isPlaceholderTitle(title: string, filenames: readonly string[] = []): boolean {
  const t = title.trim();
  if (t === '') return true;
  const lower = t.toLowerCase();
  for (const filename of filenames) {
    const name = filename.trim().toLowerCase();
    const stem = name.replace(/\.[^.]+$/, '');
    if (lower === name || (stem !== '' && lower === stem)) return true;
  }
  const m =
    /^(\d{4})([_-])(\d{2})\2(\d{2})(?:[_-](\d{2})[_-](\d{2})[_-](\d{2}))?(?:\.[a-z0-9]{1,5})?$/i.exec(
      t,
    );
  if (!m) return false;
  const [, , , month, day, hour, min, sec] = m;
  const mm = Number(month), dd = Number(day);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  if (hour === undefined) return true;
  return Number(hour) <= 23 && Number(min) <= 59 && Number(sec) <= 59;
}

export function isEmptyChanges(changes: AutofillChanges): boolean {
  return (
    changes.title === undefined &&
    changes.notebook === undefined &&
    changes.tags.length === 0 &&
    changes.fields.length === 0
  );
}

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

function isBlank(value: FieldValue | null | undefined): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** A multi-select compares as a set, as `note-patch` compares it: order is not an edit. */
function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const as = Array.isArray(a) ? a : [String(a)];
    const bs = Array.isArray(b) ? b : [String(b)];
    return as.length === bs.length && as.every((v) => bs.includes(v));
  }
  return a === b || String(a) === String(b);
}

/**
 * `filenames` are the note's own files, for `isPlaceholderTitle`: a title that is just one
 * of their names is filled over rather than offered.
 */
export function planAutofill(
  draft: NoteDraft,
  suggestion: AutofillSuggestion,
  filenames: readonly string[] = [],
): AutofillPlan {
  const fill = nothing();
  const replace = nothing();

  if (suggestion.title) {
    if (isPlaceholderTitle(draft.title, filenames)) fill.title = suggestion.title.value;
    else if (draft.title.trim() !== suggestion.title.value) replace.title = suggestion.title.value;
  }

  /*
     Whether the suggestion moves the note out of a notebook it is already in. The fields
     that came with it are that notebook's, so they mean nothing unless the move happens:
     they go with it, to be applied or declined together, rather than landing as foreign
     values on a note that stayed put.
  */
  let moving = false;
  if (suggestion.notebook) {
    if (draft.notebook === null) fill.notebook = suggestion.notebook.name;
    else if (!sameName(draft.notebook, suggestion.notebook.name)) {
      replace.notebook = suggestion.notebook.name;
      moving = true;
    }
  }

  const has = new Set(draft.tags.map((t) => t.toLowerCase()));
  fill.tags = suggestion.tags.map((t) => t.name).filter((name) => !has.has(name.toLowerCase()));

  for (const { field, value } of suggestion.fields) {
    const change = { def: field, value };
    if (moving) {
      replace.fields.push(change);
      continue;
    }
    const current = draft.fields[field.id];
    if (isBlank(current)) fill.fields.push(change);
    else if (!sameValue(current!, value)) replace.fields.push(change);
  }

  return { fill, replace };
}

/** The draft with the changes in it. A new object, since autosave compares by reference. */
export function applyAutofill(draft: NoteDraft, changes: AutofillChanges): NoteDraft {
  const fields = { ...draft.fields };
  for (const { def, value } of changes.fields) fields[def.id] = value;
  return {
    ...draft,
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.notebook !== undefined ? { notebook: changes.notebook } : {}),
    tags: changes.tags.length > 0 ? [...draft.tags, ...changes.tags] : draft.tags,
    fields: changes.fields.length > 0 ? fields : draft.fields,
  };
}

/**
 * "the title, the notebook, 2 tags and Amount": what a status line or a question names.
 * One field is named, since that is what the person will look for; more are counted.
 */
export function describeChanges(changes: AutofillChanges): string {
  const parts: string[] = [];
  if (changes.title !== undefined) parts.push('the title');
  if (changes.notebook !== undefined) parts.push('the notebook');
  if (changes.tags.length === 1) parts.push('a tag');
  else if (changes.tags.length > 1) parts.push(`${changes.tags.length} tags`);
  if (changes.fields.length === 1) parts.push(changes.fields[0]!.def.name);
  else if (changes.fields.length > 1) parts.push(`${changes.fields.length} fields`);

  return andList(parts) || 'nothing';
}
