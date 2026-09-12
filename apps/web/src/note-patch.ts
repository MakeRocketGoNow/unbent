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

  const fields = fieldPatch(draft.fields, note.fields ?? [], definitions);
  if (fields) patch.fields = fields;

  return Object.keys(patch).length > 0 ? patch : null;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/**
 * Only the field ids whose draft value differs from what is stored, and only when that
 * value can actually be written. Unknown ids (a field deleted in another tab) and
 * values the type cannot read yet ("12.", "http://") are skipped rather than sent.
 */
function fieldPatch(
  draft: Record<string, FieldValue | null>,
  stored: NoteFieldValue[],
  definitions: FieldDef[] | undefined,
): NoteFieldsPatch | null {
  const previous = new Map(stored.map((v) => [v.fieldId, v]));
  const defs = new Map((definitions ?? []).map((d) => [d.id, d]));
  const patch: NoteFieldsPatch = {};

  for (const [id, value] of Object.entries(draft)) {
    const held = previous.get(id);
    if (value === null || value === undefined) {
      if (held) patch[id] = null;
      continue;
    }
    if (held && sameFieldValue(held.value, value)) continue;

    const def = defs.get(id) ?? (held ? { type: held.type, options: [] as string[] } : undefined);
    if (!def) continue;
    if (encodeFieldValue(def, value) === null) continue;
    patch[id] = value;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function sameFieldValue(a: FieldValue, b: FieldValue): boolean {
  return a === b || String(a) === String(b);
}
