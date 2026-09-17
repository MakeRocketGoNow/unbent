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
