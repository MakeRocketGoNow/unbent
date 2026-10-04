import {
  REVISION_MAX_AGE_MS,
  REVISION_WINDOW_MS,
  REVISIONS_KEPT,
  NOTE_REVISION_CHANGES,
  type NoteRevision,
  type NoteRevisionCause,
  type NoteRevisionChange,
  type NoteRevisionProps,
  type NoteRevisionSummary,
} from '@unbent/shared';
import type { Sql } from './sql.js';

// The three numbers are in `@unbent/shared`, where the History sheet reads them too.
export { REVISION_MAX_AGE_MS, REVISION_WINDOW_MS, REVISIONS_KEPT };

/** Who is writing: nobody named is the person, in the editor or the list. */
export type RevisionWriter = 'assistant' | 'restore' | undefined;

/**
 * The note a write is about to replace part of: its text and date, and how many field
 * values it carries, which is all `keep` needs to decide. Any `Note` is one.
 */
export interface NoteBefore {
  title: string;
  body: string;
  updatedAt: number;
  fields?: readonly unknown[] | undefined;
}

interface NewestRow {
  id: number;
  created_at: number;
  through: number;
  cause: string | null;
  changed: string | null;
}

/**
 * A note's history (schemas 0003 and 0004): the copies kept of what a write replaced.
 *
 * Private helpers in the sense `Sql.tx` means — nothing here opens a transaction, and
 * `keep` is only ever called from inside the one that replaces the text, so a copy is
 * kept if and only if the write it guards lands. Nothing here records in the change
 * feed either: history is the server's, asked for when the History sheet opens, and a
 * device that held every note's copies would be holding fifty bodies per note.
 */
export class Revisions {
  constructor(private readonly sql: Sql) {}

  /**
   * Keeps `was` — the note as it stood — if this write is one that should leave a copy,
   * then prunes the note's history. `stamp` is the `updated_at` the write is giving the
   * note; `was.updatedAt` is the one it had. `changed` is which parts of the note the
   * write replaces, and `props` reads the rest of what a copy holds — the notebook, the
   * tags by id, the field values — asked for only when a copy is actually taken, which
   * is once a sitting; every other save would be reading tags to throw them away.
   *
   * A sitting leaves a copy only when the newest one is older than the window, so it is
   * one row: the note as it was before the sitting began. That is the issue's rule and
   * it is enough for typing, where the editor's own undo covers the last few minutes.
   * Changing a field, a tag or the notebook is the same sitting (MAK-170): a run of
   * field edits is one version, not ten, and typing after it adds none.
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
   * text, rather than thirty that crowd the copies kept.
   *
   * A restore always keeps what it replaces. It is one deliberate act, and being able to
   * undo it is the point.
   *
   * A write that is covered by the newest copy still tells that copy what it changed,
   * when it is a part no earlier write of the sitting touched: the row says what the
   * copy stands for, and it stands for this write too. That is a row written at most
   * three times a sitting, since there are four parts.
   *
   * Answers with the id of the copy it kept, or null when it kept none. A restore hands
   * that id to its caller, since it is the copy an Undo puts back and only this insert
   * knows which row that is.
   */
  keep(
    noteId: string,
    was: NoteBefore,
    stamp: number,
    by: RevisionWriter,
    changed: readonly NoteRevisionChange[],
    props: () => NoteRevisionProps,
    /** The caller has already asked `covers` for this write and been told no. */
    asked = false,
  ): number | null {
    if (by !== 'restore') {
      // A note with no text and no values has nothing to lose. Every note made in the
      // app starts with an empty title and body, so without this its first save would
      // leave an empty version in every note's history, one that blanks the note if
      // restored. Where it is filed does not count, the notebook or the tags: a note
      // made inside a notebook, or while the list is filtered by a tag, is filed from
      // the start and is as empty as any other. Counting tags here gave every note made
      // under a tag filter that blank version. A restore still keeps an empty note: its
      // Undo needs that copy to put back.
      if (was.title === '' && was.body === '' && (was.fields?.length ?? 0) === 0) return null;
      if (!asked && this.covers(noteId, was.updatedAt, stamp, by, changed)) return null;
    }
    const kept = this.sql.first<{ id: number }>(
      `INSERT INTO note_revisions (note_id, title, body, size, created_at, through, cause, props, changed)
       VALUES (?1, ?2, ?3, length(?3), ?4, ?4, ?5, ?6, ?7)
       RETURNING id`,
      noteId,
      was.title,
      was.body,
      stamp,
      by ?? null,
      JSON.stringify(props()),
      inOrder(changed).join(','),
    );
    this.prune(noteId, stamp);
    return kept?.id ?? null;
  }

  /**
   * Whether the note's newest copy already stands for this write, so none need be kept:
   * the half of `keep`'s decision that needs nothing of the note but its date. When it
   * does, the copy is told what this write changed and, for an assistant's run, how far
   * the run has got — so a caller that hears yes has nothing more to do.
   *
   * Apart from `keep` for the bulk verb, which would otherwise read every note it
   * changes whole, body and all, to learn that most of them are inside their window and
   * keep nothing. It asks this first, with the date it already has, and reads only the
   * notes it will copy. Never asked for a restore, which always keeps.
   */
  covers(
    noteId: string,
    wasUpdatedAt: number,
    stamp: number,
    by: Exclude<RevisionWriter, 'restore'>,
    changed: readonly NoteRevisionChange[],
  ): boolean {
    const newest = this.sql.first<NewestRow>(
      `SELECT id, created_at, through, cause, changed FROM note_revisions
        WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      noteId,
    );
    if (newest === null || stamp - newest.created_at >= REVISION_WINDOW_MS) return false;
    if (by === undefined) {
      this.alsoChanged(newest, changed);
      return true;
    }
    if (newest.cause === 'assistant' && newest.through === wasUpdatedAt) {
      this.sql.exec(`UPDATE note_revisions SET through = ?1 WHERE id = ?2`, stamp, newest.id);
      this.alsoChanged(newest, changed);
      return true;
    }
    return false;
  }

  /**
   * Adds to what a copy says its writes changed, and writes nothing when they are parts
   * it already names. A copy from before `changed` was recorded is left as it is: it has
   * no list to add to, and one begun now would say "tags" of a copy kept for its text.
   */
  private alsoChanged(newest: NewestRow, changed: readonly NoteRevisionChange[]): void {
    if (newest.changed === null) return;
    const had = changesOf(newest.changed);
    if (changed.every((c) => had.includes(c))) return;
    this.sql.exec(`UPDATE note_revisions SET changed = ?1 WHERE id = ?2`, inOrder([...had, ...changed]).join(','), newest.id);
  }

  /**
   * Retention, for this note only and only when a copy was just added: no cron, and no
   * pass over every note of an account. Both halves walk the note's own run of the index
   * — at most a row past the limit, since this runs after every insert — so a note with
   * a full history reads about twice `REVISIONS_KEPT` index entries here and nothing else.
   *
   * A note nobody writes to again keeps copies past the age limit on disk; `list` and `get`
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
   * A note's copies, newest first, without their bodies or what else they hold: fifty
   * bodies is megabytes on a long note, and the sheet shows one at a time. `size` is the body's length in
   * characters, which is what lets a row say a copy was much longer than the note is now
   * — the gutted note is the case this whole table is for. A column, so the bodies are
   * not read to count them; see 0003.
   */
  list(noteId: string, now: number): NoteRevisionSummary[] {
    return this.sql
      .exec<{ id: number; title: string; size: number; created_at: number; cause: string | null; changed: string | null }>(
        `SELECT id, title, size, created_at, cause, changed FROM note_revisions
          WHERE note_id = ?1 AND created_at >= ?2
          ORDER BY created_at DESC, id DESC LIMIT ?3`,
        noteId,
        now - REVISION_MAX_AGE_MS,
        REVISIONS_KEPT,
      )
      .map((r) => ({ id: r.id, title: r.title, size: r.size, createdAt: r.created_at, ...causeOf(r.cause), ...changedOf(r.changed) }));
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
    const r = this.sql.first<{
      id: number;
      title: string;
      body: string;
      size: number;
      created_at: number;
      cause: string | null;
      changed: string | null;
      props: string | null;
    }>(
      `SELECT id, title, body, size, created_at, cause, changed, props FROM note_revisions
        WHERE id = ?1 AND note_id = ?2 AND created_at >= ?3`,
      id,
      noteId,
      now - REVISION_MAX_AGE_MS,
    );
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      size: r.size,
      createdAt: r.created_at,
      ...causeOf(r.cause),
      ...changedOf(r.changed),
      // NULL is a copy from before 0004: not recorded, which is not the same as none.
      ...(r.props !== null ? { props: JSON.parse(r.props) as NoteRevisionProps } : {}),
    };
  }
}

function causeOf(cause: string | null): { cause?: NoteRevisionCause } {
  return cause === 'assistant' || cause === 'restore' ? { cause } : {};
}

function changesOf(changed: string): NoteRevisionChange[] {
  const named = changed.split(',');
  return NOTE_REVISION_CHANGES.filter((c) => named.includes(c));
}

function changedOf(changed: string | null): { changed?: NoteRevisionChange[] } {
  return changed === null ? {} : { changed: changesOf(changed) };
}

/** Each part once, in the order a row says them, whatever order the writes came in. */
function inOrder(changed: readonly NoteRevisionChange[]): NoteRevisionChange[] {
  return NOTE_REVISION_CHANGES.filter((c) => changed.includes(c));
}
