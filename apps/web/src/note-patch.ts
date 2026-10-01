import {
  encodeFieldValue,
  type FieldDef,
  type FieldValue,
  type Note,
  type NoteFieldValue,
  type NoteFieldsPatch,
} from '@unbent/shared';

/** What the editor holds, and what a save used to send in full. */
export interface NoteDraft {
  title: string;
  body: string;
  tags: string[];
  notebook: string | null;
  fields: Record<string, FieldValue | null>;
}

export type NotePatch = {
  title?: string;
  body?: string;
  tags?: string[];
  notebook?: string | null;
  fields?: NoteFieldsPatch;
};

/** The draft a note's saved copy starts as. */
export function seedFrom(note: Pick<Note, 'title' | 'body' | 'tags' | 'notebook' | 'fields'>): NoteDraft {
  return {
    title: note.title,
    body: note.body,
    tags: note.tags,
    notebook: note.notebook ?? null,
    fields: Object.fromEntries((note.fields ?? []).map((v) => [v.fieldId, v.value])) as Record<
      string,
      FieldValue | null
    >,
  };
}

/**
 * Whether a save refused as stale would take nothing from the note as it now stands:
 * every change made to it since `base` — the copy the editor last had from the server —
 * is one the draft already holds.
 *
 * Then the refusal was not a conflict, only a date that moved, and the editor saves again
 * against the new copy instead of asking. The ordinary way here is a bulk action on the
 * list that included the open note: it refiles the note on the server, moving its date,
 * and hands the same notebook and tags to the draft (`registerOpenNoteFilingEdit`). Two
 * devices making the same edit is the other. Anything else — a title changed elsewhere
 * that the draft still has the old version of — is a real choice, and the person makes it.
 *
 * Tags compare as sets, as the server compares them: it returns them sorted, and the
 * draft holds them in the order they were added.
 */
export function holdsTheirChanges(
  draft: NoteDraft,
  base: Pick<Note, 'title' | 'body' | 'tags' | 'notebook' | 'fields'>,
  current: Pick<Note, 'title' | 'body' | 'tags' | 'notebook' | 'fields'>,
): boolean {
  const was = seedFrom(base);
  const now = seedFrom(current);

  if (now.title !== was.title && draft.title !== now.title) return false;
  if (now.body !== was.body && draft.body !== now.body) return false;
  if (now.notebook !== was.notebook && draft.notebook !== now.notebook) return false;
  if (!sameTagSet(now.tags, was.tags) && !sameTagSet(draft.tags, now.tags)) return false;

  for (const id of new Set([...Object.keys(now.fields), ...Object.keys(was.fields)])) {
    const theirs = now.fields[id] ?? null;
    if (sameOrBothEmpty(theirs, was.fields[id] ?? null)) continue;
    if (!sameOrBothEmpty(draft.fields[id] ?? null, theirs)) return false;
  }
  return true;
}

function sameTagSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag) => b.includes(tag));
}

function sameOrBothEmpty(a: FieldValue | null, b: FieldValue | null): boolean {
  if (a === null || b === null) return a === b;
  return sameFieldValue(a, b);
}

/**
 * Definitions this session has already loaded, so a notebook change does not forget
 * the types a draft value was typed against.
 *
 * `buildNotePatch` encodes a value the note has never stored from the definition list
 * it is handed. After the note is moved, that list is the *new* notebook's — or
 * undefined while those definitions load — so an Amount typed on Receipts and a move
 * to Taxes in the same breath used to drop the number: no definition in the new list,
 * no stored row, skip. The server would have accepted it; the field still exists on
 * Receipts, and a value already saved would have survived as a foreign field.
 *
 * Accumulating every definition we have seen keeps the type around long enough to
 * write what the user typed. The editor still *shows* only the current notebook's
 * fields; this list is only for the patch.
 *
 * A field deleted in another tab can still 400 the save if they edit it, the same
 * way changing an already-stored value of a deleted field already can (`stands.type`
 * in `diffFields`). That is rarer than losing a just-typed amount to a filing.
 */
export function rememberFieldDefs(
  seen: Map<string, FieldDef>,
  current: FieldDef[] | undefined,
): FieldDef[] {
  if (current) {
    for (const def of current) seen.set(def.id, def);
  }
  return [...seen.values()];
}

/**
 * The PATCH a note save should send, given the draft and what the server last told us.
 *
 * The editor used to send the whole draft on every autosave. The API is merge-shaped —
 * only named keys change — and the Android note screen depends on that: it writes the
 * title natively and the body through the embed, and the two must not overwrite each
 * other. Sending the stale title along with a body edit put the phone's rename back.
 *
 * The same full draft is why a half-typed number, a URL still being written, or a field
 * the notebook no longer has used to 400 the whole save, title and body included. Those
 * values are left out here; the next keystroke that makes them storeable will include
 * them. An empty return means nothing storeable changed, so the caller should not hit
 * the network.
 */
export function buildNotePatch(
  draft: NoteDraft,
  note: Pick<Note, 'title' | 'body' | 'tags' | 'notebook' | 'fields'>,
  definitions: FieldDef[] | undefined,
): NotePatch | null {
  const patch: NotePatch = {};

  if (draft.title !== note.title) patch.title = draft.title;
  if (draft.body !== note.body) patch.body = draft.body;
  if (!sameTags(draft.tags, note.tags)) patch.tags = draft.tags;

  const notebook = note.notebook ?? null;
  if (draft.notebook !== notebook) patch.notebook = draft.notebook;

  const { patch: fields } = diffFields(draft.fields, note.fields ?? [], definitions);
  if (fields) patch.fields = fields;

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The field ids whose draft value this save is leaving behind, because the type cannot
 * read it yet — a number still at "12.", a URL at "http://".
 *
 * Skipping them is what keeps the title and body typed in the same breath saveable, but
 * it means a save can report success while one of these values exists nowhere but the
 * draft. The editor asks so its indicator can go on saying "Unsaved", rather than
 * claiming work the server does not have and letting the user walk away on that word.
 *
 * An id the notebook no longer defines is not in here. There is nothing to type that
 * would make it storeable, and nothing for the editor to point at.
 */
export function unstoreableFieldIds(
  draft: NoteDraft,
  note: Pick<Note, 'fields'>,
  definitions: FieldDef[] | undefined,
): string[] {
  return diffFields(draft.fields, note.fields ?? [], definitions).held;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/**
 * Only the field ids whose draft value differs from what is stored, and only when that
 * value can actually be written. Unknown ids (a field deleted in another tab) and
 * values the type cannot read yet ("12.", "http://") are skipped rather than sent.
 *
 * The skipped-for-now ids come back alongside the patch: they are the difference between
 * "nothing changed" and "something changed that cannot be written yet", and only the
 * caller can tell the user which one it is looking at.
 */
function diffFields(
  draft: Record<string, FieldValue | null>,
  stored: NoteFieldValue[],
  definitions: FieldDef[] | undefined,
): { patch: NoteFieldsPatch | null; held: string[] } {
  const previous = new Map(stored.map((v) => [v.fieldId, v]));
  const defs = new Map((definitions ?? []).map((d) => [d.id, d]));
  const patch: NoteFieldsPatch = {};
  const held: string[] = [];

  for (const [id, value] of Object.entries(draft)) {
    const stands = previous.get(id);
    if (value === null || value === undefined) {
      if (stands) patch[id] = null;
      continue;
    }
    if (stands && sameFieldValue(stands.value, value)) continue;

    const def = defs.get(id) ?? (stands ? { type: stands.type, options: [] as string[] } : undefined);
    // No type and nothing stored: a leftover id, or a just-typed value whose definition
    // this call was not handed. The callers accumulate every definition they have loaded
    // (`rememberFieldDefs`) so a notebook change still has the type the value was typed
    // against. An id we have never seen is skipped, so a stale draft key cannot 400
    // the rest of the save.
    if (!def) continue;

    const encoded = encodeFieldValue(def, value);
    if (encoded === null) {
      held.push(id);
      continue;
    }
    /*
       An emptied input is "no value", never the empty string, so it sends the same null
       the branch above does — and is skipped the same way when the note has nothing to
       clear. The server reads a bare '' as a clear too, but this function is written
       against its own contract rather than against what the far end happens to forgive.
    */
    if (encoded === 'clear') {
      if (stands) patch[id] = null;
      continue;
    }
    patch[id] = value;
  }

  return { patch: Object.keys(patch).length > 0 ? patch : null, held };
}

/**
 * Whether a draft value is the stored one. A multi-select is compared as a set: the
 * server stores its options in the option list's order, and the editor holds them in the
 * order they were picked, which is not an edit.
 */
function sameFieldValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const as = Array.isArray(a) ? a : [String(a)];
    const bs = Array.isArray(b) ? b : [String(b)];
    return as.length === bs.length && as.every((v) => bs.includes(v));
  }
  return a === b || String(a) === String(b);
}
