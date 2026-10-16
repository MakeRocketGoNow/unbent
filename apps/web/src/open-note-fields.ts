import type { FieldValue } from '@unbent/shared';

/**
 * Lets the table edit a field of the note that is open beside it.
 *
 * The open note's editor holds a draft, seeded once when the note loads, and its autosave
 * writes whatever differs between that draft and the note the server last returned. A
 * table cell that saved straight to the API would leave the draft holding the old value,
 * and the editor's next save would put it back. So an edit to the *open* note goes into
 * the draft instead, and the editor saves it the way it saves a value typed in the
 * property list.
 *
 * A registration rather than a prop chain, like `registerEditorFocus`: the table and the
 * editor are siblings under a route with the whole layout between them. The workspace
 * registers while it is editing a note and withdraws when it stops.
 */
let openNote: { noteId: string; edit: (fieldId: string, value: FieldValue | null) => void } | null =
  null;

export function registerOpenNoteFieldEdit(
  noteId: string,
  edit: (fieldId: string, value: FieldValue | null) => void,
): () => void {
  openNote = { noteId, edit };
  return () => {
    if (openNote?.noteId === noteId) openNote = null;
  };
}

/** Hands the edit to the open note's editor. False when that note is not open for editing. */
export function editOpenNoteField(noteId: string, fieldId: string, value: FieldValue | null): boolean {
  if (openNote?.noteId !== noteId) return false;
  openNote.edit(fieldId, value);
  return true;
}

/**
 * The same seam for the note's filing (its notebook and its tags), which a bulk action
 * on the list can change under the open note.
 *
 * The hazard is the one above, in the other direction: the list refiles forty notes,
 * one of them is open, and the editor's draft still says the old notebook. Its next
 * autosave (a keystroke in the body) would put the old filing back over the batch.
 * So the batch tells the draft what it did, the way a cell edit does, and the editor's
 * next save finds nothing to undo. Tags are given as a function of the draft's own,
 * because the batch adds and removes rather than sets: the note keeps whatever else it
 * carried, exactly as the server left it.
 */
export interface FilingEdit {
  notebook?: string | null;
  tags?: (current: string[]) => string[];
}

let openFiling: { noteId: string; edit: (change: FilingEdit) => void } | null = null;

export function registerOpenNoteFilingEdit(
  noteId: string,
  edit: (change: FilingEdit) => void,
): () => void {
  openFiling = { noteId, edit };
  return () => {
    if (openFiling?.noteId === noteId) openFiling = null;
  };
}

/** Hands a filing change to the open note's editor. False when that note is not open for editing. */
export function editOpenNoteFiling(noteId: string, change: FilingEdit): boolean {
  if (openFiling?.noteId !== noteId) return false;
  openFiling.edit(change);
  return true;
}
