import type { AutofillSuggestion, FieldDef, FieldValue } from '@unbent/shared';
import type { NoteDraft } from './note-patch.js';

/**
 * Applying an auto-fill suggestion to the editor's draft.
 *
 * The server judges; this decides what to do with the judgement, by one rule: fill what
 * is empty without asking, and ask before replacing anything already set. A freshly
 * scanned note is untitled, unfiled and untagged, so on the case this exists for
 * everything lands at once. A note someone has already filed gets its empties filled and
 * an offer for the rest, which is the warning the issue asked for without a dialog in
 * front of the common case.
 *
 * Into the draft rather than to the server, for the reason `open-note-fields.ts` gives
 * for the table's edits: the draft is what autosave writes, and a value put on the server
 * behind it would be put back by the next keystroke. Landing here also makes the fill an
 * ordinary edit — undone by retyping, saved when the note saves.
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

export function planAutofill(draft: NoteDraft, suggestion: AutofillSuggestion): AutofillPlan {
  const fill = nothing();
  const replace = nothing();

  if (suggestion.title) {
    if (draft.title.trim() === '') fill.title = suggestion.title.value;
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

  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
