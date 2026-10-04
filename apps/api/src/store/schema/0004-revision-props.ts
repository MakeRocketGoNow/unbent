/**
 * What a version holds besides its text (MAK-170): the note's field values, its tags and
 * its notebook, and what the writes the copy stands for changed.
 *
 * 0003 kept the title and body only, on the reasoning that the rest was "cheap to redo
 * by hand". That was wrong for the notebooks that are mostly fields — a watch list, a
 * log, a set of business cards — where the fields are the note: changing three of them
 * and opening History showed nothing, and Restore could not put them back.
 *
 * `props` is one JSON value, a `NoteRevisionProps`: the notebook and each tag by id and
 * by the name of the time, and the field values as the note carried them, definitions'
 * names and types included. One column rather than a table of values per version,
 * because a version is only ever read whole, by its own id, and never searched by what
 * it holds; three more tables would be rows written per copy for no read that wants
 * them. NULL is every copy kept before this file, and it means "not recorded": such a
 * version shows no fields and Restore leaves the note's own alone. It must never be
 * read as "the note had none", which is a `props` with empty lists.
 *
 * `changed` is which parts of the note the writes this copy stands for replaced —
 * 'text', 'fields', 'tags', 'notebook', comma-separated — so the list can say "Fields
 * changed" on a row that would otherwise read exactly like the one before it. The list
 * reads it without the body or `props`. It grows when a later write inside the same
 * window changes another part, since the copy stands for that write too. NULL on the
 * copies from before, every one of which was kept for a change of text.
 *
 * No new index: both columns are only read with the row.
 */
export default `
ALTER TABLE note_revisions ADD COLUMN props TEXT;
ALTER TABLE note_revisions ADD COLUMN changed TEXT;
`;
