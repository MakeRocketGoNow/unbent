import { z } from 'zod';
import type { FieldDef } from './fields.js';
import type { AttachmentInfo, Note, NotebookSummary } from './schemas.js';
import type { NotebookView } from './views.js';

/**
 * The change feed: what `GET /api/changes` and `GET /api/changes/snapshot` answer.
 *
 * Written from the reader's side. A client keeps five collections (notes, notebooks,
 * tags, files, views) and applies a page by upserting each row it carries and deleting
 * each tombstone; the shapes here are the rows those collections hold, which is why a note
 * comes whole (body, tags, fields, files) rather than as the list's excerpt. The server
 * side is `UserStore.changesSince` and `snapshotPage`.
 */

/** What the feed names. A note covers its tags, fields and files; a notebook its field definitions. */
export type FeedEntity = 'note' | 'notebook' | 'tag' | 'attachment' | 'view';

/**
 * A note as the feed carries it: the note, trashed or not, with its files and its tags by
 * id, and without the names `Note` carries for its tags and notebook. A tag or notebook
 * rename is one row for the tag or notebook, so a name copied onto every note would be
 * stale from the next rename on; the client renders `tagIds` and `notebookId` against the
 * tags and notebooks it holds, and the names are not here to be rendered by mistake. A
 * tag on thirteen thousand notes renamed would otherwise be thirteen thousand notes
 * downloaded whole by every device.
 *
 * `fields` keeps the full value shape, names included, for one reason: a value can key a
 * definition whose notebook was deleted, which the store keeps as a tombstone so the
 * value stays readable with its label, and which the client no longer holds. Render a
 * value from the definition you hold by `fieldId`; the carried name, type and notebook
 * are for the definition you do not, which is the one case they are current.
 */
export interface FeedNote extends Omit<Note, 'tags' | 'notebook'> {
  tagIds: string[];
  /**
   * The note's files with their ids and `hasText`, the same rows the feed's `attachments`
   * carry, so a snapshot seeds the files collection and an attachment tombstone, keyed by
   * id, matches a file the client holds.
   */
  files: FeedAttachment[];
}

/**
 * A notebook with its field definitions, in display order. No counts: tagging, filing
 * and trashing a note move a notebook's and a tag's counts without recording either, so
 * a count carried here would be the value as of some unrelated row and wrong by the next
 * write. A client derives its counts from the notes it holds, which it has whole.
 */
export interface FeedNotebook extends Pick<NotebookSummary, 'id' | 'name' | 'purpose' | 'emoji'> {
  fieldDefs: FieldDef[];
}

/**
 * A tag, by id and name, with the colour it wears (an index into the palette; see
 * `colors.ts`). Null only on a row read before its store has coloured it. No count, for
 * the reason `FeedNotebook` gives.
 */
export interface FeedTag {
  id: string;
  name: string;
  color: number | null;
}

/** A file's row: what changes when its text arrives (`hasText`) or it is copied. */
export interface FeedAttachment extends AttachmentInfo {
  id: string;
  noteId: string;
  hasText: boolean;
  createdAt: number;
}

/**
 * A saved view, whole: the row is small and a change to its query is the whole row again.
 * A notebook deleted tombstones each of its views, so a client never derives that.
 */
export type FeedView = NotebookView;

/** Something gone for good: a purged note, a deleted notebook, tag or view, a removed file. */
export interface FeedTombstone {
  entity: FeedEntity;
  id: string;
}

/**
 * One page of the feed after a cursor.
 *
 * `next` is the last seq the page covers and the next call's `since`; `more` says the
 * page was full or cut short on bytes, so the client should call again at once. Within a
 * page the last word per entity wins, so an entity is in exactly one of the arrays.
 */
export interface FeedPage {
  reset: false;
  /** The counter now. */
  seq: number;
  /** The name of this history; a client that stored a different one starts over. */
  epoch: string;
  next: number;
  more: boolean;
  notes: FeedNote[];
  notebooks: FeedNotebook[];
  tags: FeedTag[];
  attachments: FeedAttachment[];
  /**
   * Always sent, `[]` when none changed. Absent only from a Worker built before views (a
   * rollback, with the views still in the store), which a client reads as view rows it
   * has passed over: its views are not whole from there, and it asks for them (`FeedEngine`).
   */
  views?: FeedView[];
  tombstones: FeedTombstone[];
}

/**
 * The cursor cannot be served: it is past the counter (the store was wound back), before
 * the oldest row kept (pruned), or from another epoch than the one the client sent. The
 * client drops its copy and takes a snapshot. Never a partial feed over a stale cursor.
 */
export interface FeedReset {
  reset: true;
  seq: number;
  epoch: string;
}

/**
 * One page of the whole library, by note id, for a client with no copy yet. The first
 * page (no cursor) also carries the notebooks, the tags, the total, and the `seq` and
 * `epoch` to follow the feed from: a client stores that seq *before* applying the first
 * page, so anything written during the walk is replayed by the feed, and every apply is
 * an upsert.
 */
export interface SnapshotPage {
  seq: number;
  epoch: string;
  notes: FeedNote[];
  /** The note id to continue from, or null on the last page. */
  next: string | null;
  /** On the first page only: the rest of the library, and how many notes the walk will visit. */
  notebooks?: FeedNotebook[];
  tags?: FeedTag[];
  /**
   * On the first page too, `[]` when there are none. Absent only from a Worker built
   * before views, which a client reads as a walk that did not see them (`FeedEngine`).
   */
  views?: FeedView[];
  total?: number;
}

/** A page is at most this many feed rows; the byte cut usually comes first for notes. */
export const FEED_PAGE_LIMIT = 500;

export const feedQuerySchema = z.object({
  /** The last seq applied; 0 for a client that has applied nothing since its snapshot. */
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(FEED_PAGE_LIMIT).default(200),
  /**
   * The epoch the cursor belongs to, as the client stored it with the cursor. Given, the
   * server answers `reset` when it differs from the store's, so a cursor from before a
   * restore is refused there rather than depending on every client remembering to
   * compare; a client that follows the feed should always send it.
   */
  epoch: z.string().min(1).optional(),
});

export const snapshotQuerySchema = z.object({
  /** The `next` of the previous page; absent for the first. */
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(FEED_PAGE_LIMIT).default(200),
});
