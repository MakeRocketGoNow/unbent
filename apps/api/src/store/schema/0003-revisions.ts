/**
 * Note history: the title and body a note had before a write replaced them, so a bad
 * edit can be undone (MAK-119). The trash covers a deleted note; this covers one whose
 * text was overwritten — by a stray paste, or by an assistant's `edit_note`.
 *
 * Title and body only. Tags, the notebook and field values are cheap to redo by hand,
 * and carrying them would triple the row shapes for something nobody restores.
 *
 * `created_at` is when the copy was taken, which is the moment the write that replaced
 * it landed. `cause` says what replaced the text when it was not ordinary typing:
 * 'assistant' for a write made over MCP, 'restore' for an earlier copy put back. NULL is
 * the editor.
 *
 * `through` is the note's `updated_at` after the last write this copy stands for: the
 * same as `created_at` when the copy is taken, and moved on by each of an assistant's
 * edits that follows directly. It is how `Revisions.keep` tells "the text being replaced
 * is the output of the edit that left this copy" from "someone has typed since", without
 * a column on the note saying who wrote it last.
 *
 * An integer key, unlike every other table here. Rule 2 in AGENTS.md keeps ids globally
 * unique for what an export or a share could name; a revision is neither exported nor in
 * the change feed, it is only ever addressed under its note, and a text key would be one
 * more index row written per copy kept.
 *
 * The one index is the two reads there are: the newest copy of a note, asked on every
 * save that changes its text, and a note's copies newest first, for the list and for
 * pruning. The cascade is what makes a purged note take its history with it; the trash
 * keeps it, since a trashed note can come back.
 */
export default `
CREATE TABLE note_revisions (
  id         INTEGER PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  through    INTEGER NOT NULL,
  cause      TEXT
);
CREATE INDEX idx_note_revisions_note ON note_revisions(note_id, created_at);
`;
