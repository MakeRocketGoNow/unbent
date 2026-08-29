/**
 * Runtime validation shared by the Worker and the SPA. Each schema is simultaneously the
 * API contract and the TypeScript type, so the two cannot drift.
 */
import { z } from 'zod';

/** D1 rejects rows over 2MB; cap note bodies below that with room for the other columns. */
export const MAX_BODY_BYTES = 1_800_000;

/** Cloudflare caps request bodies at 100MB; leave headroom for headers and metadata. */
export const MAX_ATTACHMENT_BYTES = 95 * 1024 * 1024;

export const MAX_TITLE_LENGTH = 500;
export const MAX_TAG_LENGTH = 100;

/** Rejects path separators and traversal so a filename can never escape its note prefix. */
export const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !n.includes('/') && !n.includes('\\'), 'Filename may not contain path separators')
  .refine((n) => n !== '.' && n !== '..', 'Invalid filename')
  .refine((n) => !n.startsWith('.'), 'Filename may not start with a dot');

export const tagNameSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

export const notebookNameSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

/**
 * Notebook filter value meaning "notes in no notebook".
 *
 * Shared so the client dropdown, the URL query param, and the repo predicate cannot drift
 * apart. Bracketed to stay clear of names a user would plausibly type.
 */
export const UNFILED = '[unfiled]';

export const noteIdSchema = z.string().uuid();

export const createNoteSchema = z.object({
  title: z.string().max(MAX_TITLE_LENGTH).default(''),
  body: z.string().max(MAX_BODY_BYTES).default(''),
  tags: z.array(tagNameSchema).max(100).default([]),
  notebook: notebookNameSchema.nullable().optional(),
});

export const updateNoteSchema = z.object({
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
  body: z.string().max(MAX_BODY_BYTES).optional(),
  tags: z.array(tagNameSchema).max(100).optional(),
  notebook: notebookNameSchema.nullable().optional(),
});

/**
 * How the note list is ordered.
 *
 * `updated` is the default because a notes app is usually a worklist. The others matter
 * for an archive: filing by when a document was received (`created`) or finding one by
 * name (`title`) are both ordinary questions that recency cannot answer.
 */
export const NOTE_SORTS = ['updated', 'created', 'title'] as const;
export type NoteSort = (typeof NOTE_SORTS)[number];

export const noteSortSchema = z.enum(NOTE_SORTS).default('updated');
/** Ascending is meaningful for every sort: oldest first, or A–Z. */
export const noteOrderSchema = z.enum(['asc', 'desc']).default('desc');

export const listNotesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tag: z.string().optional(),
  notebook: z.string().optional(),
  sort: noteSortSchema,
  order: noteOrderSchema,
  /** List trashed notes instead of live ones. Any value but "1" is treated as false. */
  trashed: z
    .string()
    .optional()
    .transform((v) => v === '1'),
});

/**
 * Search takes the same `tag` and `notebook` filters as the note list.
 *
 * Searching is a narrowing of the current view, not an escape from it: with a notebook
 * selected, "insurance" means "insurance in this notebook". Without these the filters
 * would silently drop the moment the user typed, which is the opposite of what selecting
 * a notebook implies.
 */
export const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tag: z.string().optional(),
  notebook: z.string().optional(),
});

/**
 * One note from an ENEX import. `contentHash` makes the endpoint idempotent so an
 * interrupted import can be re-run without duplicating notes.
 */
export const importNoteSchema = z.object({
  title: z.string().max(MAX_TITLE_LENGTH).default(''),
  body: z.string().max(MAX_BODY_BYTES).default(''),
  tags: z.array(tagNameSchema).max(100).default([]),
  notebook: notebookNameSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  contentHash: z.string().length(64),
  sourceEnex: z.string().max(255).optional(),
  /** Evernote note-attributes/source-url, kept for bookmark-style notes. */
  sourceUrl: z.string().max(2000).optional(),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type ImportNoteInput = z.infer<typeof importNoteSchema>;

export interface NoteSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  tags: string[];
  notebook?: string | null;
  excerpt?: string;
  /** When this note was trashed. Only present on notes listed from the trash. */
  deletedAt?: number;
}

export interface Note extends NoteSummary {
  body: string;
}

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface SearchResult {
  id: string;
  title: string;
  updatedAt: number;
  snippet: string;
  /** Set when the match came from an attachment's extracted text rather than the note. */
  matchedFile?: string;
}
