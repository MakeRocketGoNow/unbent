import { z } from 'zod';
import type { FieldDef } from './fields.js';
import type { AttachmentInfo, Note, NotebookSummary } from './schemas.js';

/**
 * The change feed: what `GET /api/changes` and `GET /api/changes/snapshot` answer.
 *
 * Written from the reader's side. A client keeps four collections — notes, notebooks,
 * tags, files — and applies a page by upserting each row it carries and deleting each
 * tombstone; the shapes here are the rows those collections hold, which is why a note
 * comes whole (body, tags, fields, files) rather than as the list's excerpt. The server
 * side is `UserStore.changesSince` and `snapshotPage`.
 */

/** What the feed names. A note covers its tags, fields and files; a notebook its field definitions. */
export type FeedEntity = 'note' | 'notebook' | 'tag' | 'attachment';

/** A note as the feed carries it: the note, trashed or not, with its files. */
export interface FeedNote extends Note {
  files: AttachmentInfo[];
}

/** A notebook with its field definitions, in display order. */
export interface FeedNotebook extends NotebookSummary {
  fieldDefs: FieldDef[];
}

export interface FeedTag {
  id: string;
  name: string;
  /** Live notes carrying it, as `GET /tags` reports; a client may derive its own. */
  count: number;
}

/** A file's row: what changes when its text arrives (`hasText`) or it is copied. */
export interface FeedAttachment extends AttachmentInfo {
  id: string;
  noteId: string;
  hasText: boolean;
  createdAt: number;
}

/** Something gone for good: a purged note, a deleted notebook or tag, a removed file. */
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
  tombstones: FeedTombstone[];
}

/**
 * The cursor cannot be served: it is past the counter (the store was wound back), before
 * the oldest row kept (pruned), or from another epoch. The client drops its copy and
 * takes a snapshot. Never a partial feed over a stale cursor.
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
  total?: number;
}

/** A page is at most this many feed rows; the byte cut usually comes first for notes. */
export const FEED_PAGE_LIMIT = 500;

export const feedQuerySchema = z.object({
  /** The last seq applied; 0 for a client that has applied nothing since its snapshot. */
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(FEED_PAGE_LIMIT).default(200),
});

export const snapshotQuerySchema = z.object({
  /** The `next` of the previous page; absent for the first. */
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(FEED_PAGE_LIMIT).default(200),
});
