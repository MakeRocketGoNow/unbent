import {
  REVISION_MAX_AGE_MS,
  REVISION_WINDOW_MS,
  REVISIONS_KEPT,
  type NoteRevision,
  type NoteRevisionCause,
  type NoteRevisionSummary,
} from '@unbent/shared';
import type { Sql } from './sql.js';

// The three numbers are in `@unbent/shared`, where the History sheet reads them too.
export { REVISION_MAX_AGE_MS, REVISION_WINDOW_MS, REVISIONS_KEPT };

/** Who is replacing the text: nobody named is the editor, typing. */
export type RevisionWriter = 'assistant' | 'restore' | undefined;

interface NewestRow {
  id: number;
  created_at: number;
  through: number;
  cause: string | null;
}

/**
 * A note's history (schema 0003): the copies kept of what a write replaced.
 *
 * Private helpers in the sense `Sql.tx` means — nothing here opens a transaction, and
 * `keep` is only ever called from inside the one that replaces the text, so a copy is
 * kept if and only if the write it guards lands. Nothing here records in the change
 * feed either: history is the server's, asked for when the History sheet opens, and a
 * device that held every note's copies would be holding twenty bodies per note.
 */
export class Revisions {
  constructor(private readonly sql: Sql) {}

  /**
   * Keeps `was` — the note as it stood — if this write is one that should leave a copy,
   * then prunes the note's history. `stamp` is the `updated_at` the write is giving the
   * note; `updatedAt` is the one it had.
   *
   * Typing leaves a copy only when the newest one is older than the window, so a sitting
   * is one row: the note as it was before the sitting began. That is the issue's rule and
   * it is enough for typing, where the editor's own undo covers the last few minutes.
   *
   * It is not enough for an assistant. "I wrote this just now; tidy it up" is the usual
   * way an `edit_note` arrives, and under the window alone the copy from the start of
   * the sitting would suppress the one that matters — the text as the person left it,
   * minutes old, about to be replaced by something they did not type. So a write made
   * over MCP always keeps what it replaces, with one exception: when what it replaces
   * is the output of an assistant's write that already left a copy, inside the window.
   * That is what `through` records (see 0003): it equals the note's `updated_at` when
   * nothing has been written since the edits that copy stands for, and it is moved on
   * here so the third edit of a run reads the same as the second. An assistant working
   * through a long note in thirty `edit_note` calls then leaves one copy, the person's
   * text, rather than thirty that push it out of the twenty kept.
   *
   * A restore always keeps what it replaces. It is one deliberate act, and being able to
   * undo it is the point.
   */
  keep(
    noteId: string,
    was: { title: string; body: string; updatedAt: number },
    stamp: number,
    by: RevisionWriter,
  ): void {
    if (by !== 'restore') {
      const newest = this.sql.first<NewestRow>(
        `SELECT id, created_at, through, cause FROM note_revisions
          WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        noteId,
      );
      const recent = newest !== null && stamp - newest.created_at < REVISION_WINDOW_MS;
      if (recent && by === undefined) return;
      if (recent && newest.cause === 'assistant' && newest.through === was.updatedAt) {
        this.sql.exec(`UPDATE note_revisions SET through = ?1 WHERE id = ?2`, stamp, newest.id);
        return;
      }
    }
    this.sql.exec(
      `INSERT INTO note_revisions (note_id, title, body, size, created_at, through, cause)
       VALUES (?1, ?2, ?3, length(?3), ?4, ?4, ?5)`,
      noteId,
      was.title,
      was.body,
      stamp,
      by ?? null,
    );
    this.prune(noteId, stamp);
  }

  /**
   * Retention, for this note only and only when a copy was just added: no cron, and no
   * pass over every note of an account. Both halves walk the note's own run of the index
   * — at most a row past the limit, since this runs after every insert — so a note with
   * a full history reads about twenty index entries here and nothing else.
   *
   * A note nobody writes to again keeps copies past ninety days on disk; `list` and `get`
   * apply the same cutoff, so they are never shown, and the next write removes them.
   */
  private prune(noteId: string, now: number): void {
    this.sql.exec(
      `DELETE FROM note_revisions
        WHERE note_id = ?1
          AND (created_at < ?2
               OR id NOT IN (SELECT id FROM note_revisions
                              WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?3))`,
      noteId,
      now - REVISION_MAX_AGE_MS,
      REVISIONS_KEPT,
    );
  }

  /**
   * A note's copies, newest first, without their bodies: twenty bodies is a megabyte on
   * a long note, and the sheet shows one at a time. `size` is the body's length in
   * characters, which is what lets a row say a copy was much longer than the note is now
   * — the gutted note is the case this whole table is for. A column, so the bodies are
   * not read to count them; see 0003.
   */
  list(noteId: string, now: number): NoteRevisionSummary[] {
    return this.sql
      .exec<{ id: number; title: string; size: number; created_at: number; cause: string | null }>(
        `SELECT id, title, size, created_at, cause FROM note_revisions
          WHERE note_id = ?1 AND created_at >= ?2
          ORDER BY created_at DESC, id DESC LIMIT ?3`,
        noteId,
        now - REVISION_MAX_AGE_MS,
        REVISIONS_KEPT,
      )
      .map((r) => ({ id: r.id, title: r.title, size: r.size, createdAt: r.created_at, ...causeOf(r.cause) }));
  }

  /**
   * Removes every copy of a note, and says how many went. All of them, including the
   * ones past the age limit that `list` no longer shows and nothing has pruned yet: the
   * person asking wants text gone, and "gone from the list" is not that.
   */
  clear(noteId: string): number {
    return this.sql.exec<{ id: number }>(`DELETE FROM note_revisions WHERE note_id = ?1 RETURNING id`, noteId).length;
  }

  /** One copy, whole. Addressed under its note, so an id from another note reads as missing. */
  get(noteId: string, id: number, now: number): NoteRevision | null {
    const r = this.sql.first<{ id: number; title: string; body: string; size: number; created_at: number; cause: string | null }>(
      `SELECT id, title, body, size, created_at, cause FROM note_revisions
        WHERE id = ?1 AND note_id = ?2 AND created_at >= ?3`,
      id,
      noteId,
      now - REVISION_MAX_AGE_MS,
    );
    if (!r) return null;
    return { id: r.id, title: r.title, body: r.body, size: r.size, createdAt: r.created_at, ...causeOf(r.cause) };
  }
}

function causeOf(cause: string | null): { cause?: NoteRevisionCause } {
  return cause === 'assistant' || cause === 'restore' ? { cause } : {};
}
