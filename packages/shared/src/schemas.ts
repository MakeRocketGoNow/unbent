/**
 * Runtime validation shared by the Worker and the SPA. Each schema is simultaneously the
 * API contract and the TypeScript type, so the two cannot drift.
 */
import { z } from 'zod';

/** D1 rejects rows over 2MB; cap note bodies below that with room for the other columns. */
export const MAX_BODY_BYTES = 1_800_000;

/** Cloudflare caps request bodies at 100MB; leave headroom for headers and metadata. */
export const MAX_ATTACHMENT_BYTES = 95 * 1024 * 1024;

/**
 * ENML accepted for server-side conversion.
 *
 * Larger than MAX_BODY_BYTES because ENML is markup around the same text — a note whose
 * Markdown fits comfortably can carry several times that in tags and inline styling. The
 * converted result is still checked against MAX_BODY_BYTES, so this only decides how much
 * markup is worth attempting rather than what may be stored.
 */
export const MAX_ENML_BYTES = 8 * 1024 * 1024;

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
 * The `tag` filter, which may be given more than once.
 *
 * Repeated params (`?tag=a&tag=b`) rather than one delimited value, because a tag name may
 * contain whatever character the delimiter would have been — this archive has tags with
 * spaces, dots and digits — and an escaping scheme is a bug waiting to happen. Hono hands
 * back a bare string for one occurrence and an array for several, so both are coerced to
 * an array here and every caller downstream sees the same shape.
 *
 * Several tags narrow conjunctively: a note must carry all of them. Union was never the
 * useful reading — two common tags OR'd together return most of an archive rather than
 * narrowing it — and AND makes the one-tag case identical to what a single filter meant
 * before, which is what lets this be a widening rather than a change in behaviour.
 */
export const tagFilterSchema = z
  .union([tagNameSchema, z.array(tagNameSchema)])
  .optional()
  .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]))
  .pipe(z.array(tagNameSchema).max(20).optional());

/**
 * Notebook filter value meaning "notes in no notebook".
 *
 * Shared so the client dropdown, the URL query param, and the repo predicate cannot drift
 * apart. Bracketed to stay clear of names a user would plausibly type.
 */
export const UNFILED = '[unfiled]';

/**
 * The sign-in methods that are not an OAuth provider.
 *
 * These are the ones this codebase implements rather than delegates, so they are the only
 * ones it can name. Social providers are deliberately absent: Better Auth ships
 * thirty-five, an instance enables any of them by setting `<PROVIDER>_CLIENT_ID` and
 * `<PROVIDER>_CLIENT_SECRET`, and a fixed list here would mean the server could offer
 * something the client refused to render. `AppConfig.providers` therefore carries plain
 * strings, and a client shows what it is told.
 *
 * `password` is what a self-hosted instance can always rely on: it needs nothing
 * registered with a third party, unlike OAuth, whose callback URLs cannot be registered on
 * a self-hoster's behalf.
 *
 * `passkey` needs nothing registered either — the other half of WebAuthn is the browser
 * and the user's own device. It is not a way to *create* an account: one is added from
 * settings once you are signed in by something else, and only then appears on the sign-in
 * screen as a way back in.
 *
 * `email-otp` can create an account without any third-party account at all, needing only
 * that the instance can send mail — so where there is mail, it is the floor: without it an
 * instance offering only OAuth turns anyone lacking those accounts away at the door.
 *
 * Where there is no mail either, `password` is the floor instead, and the server offers it
 * unasked. Those two are the only methods here that can start an account from nothing, so
 * between them they are what guarantees an instance can always be signed in to. A client
 * still renders whatever it is told; this is only why the list is never empty in practice.
 */
export const LOCAL_METHODS = ['password', 'passkey', 'email-otp'] as const;
export type LocalMethod = (typeof LOCAL_METHODS)[number];

/**
 * A method name as `/api/config` reports it: one of the above, or any Better Auth social
 * provider id. The union is written so a known name still autocompletes while an arbitrary
 * one is accepted.
 */
export type AuthProvider = LocalMethod | (string & {});

/** Whether a reported method is one this codebase implements rather than delegates. */
export function isLocalMethod(p: string): p is LocalMethod {
  return (LOCAL_METHODS as readonly string[]).includes(p);
}

export interface AppConfig {
  providers: AuthProvider[];
  /**
   * Whether an account can delete itself here.
   *
   * Deletion is confirmed by a link in the mail, so an instance with no mail configured
   * does not offer the endpoint at all — see `accountDeletionOffered` in the API. Settings
   * reads this to decide whether the control exists, rather than drawing a button that
   * answers 404.
   *
   * Optional so a client stays compatible with an instance older than the field, where the
   * honest reading of its absence is "not offered".
   */
  accountDeletion?: boolean;
  /**
   * Who runs this instance, for the built-in legal documents to name.
   *
   * There is deliberately no default. The documents used to name one operator from a
   * constant, which meant a self-hosted copy published somebody else's legal entity on its
   * own domain — a claim that operator never made and cannot stand behind. Absent means
   * nobody has said, and the documents say so rather than guessing.
   *
   * `host` comes from the server's `APP_URL` rather than from `location`, because the
   * address a document gives for the site should be the one its operator configured, not
   * whichever hostname a WebView or a Tailscale name happens to arrive on.
   */
  operator?: { name: string; email: string; host: string };
  /**
   * Where the privacy policy and terms are: absolute URLs when they are hosted elsewhere,
   * `/privacy` and `/terms` for the built-in ones.
   *
   * Absent means this instance publishes neither, and nothing links to them anywhere — a
   * link to a page that says "nothing here" is worse than no link at all.
   */
  legal?: { privacy: string; terms: string };
}

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

/**
 * A calendar day, `YYYY-MM-DD`, as typed by a date input.
 *
 * Dates rather than timestamps because the filter is a human question — "everything from
 * 2023" — and a timestamp boundary would make the answer depend on the hour. Interpreted
 * in UTC to match the epoch-ms columns; a local-midnight reading would shift the boundary
 * by the viewer's offset and quietly include or drop a day's notes.
 */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'not a real date');

/** Start of that UTC day. */
export function startOfDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * End of that UTC day, inclusive.
 *
 * The range is inclusive of both ends because that is what a person means by "1 January
 * to 31 January" — an exclusive upper bound silently drops everything filed on the last
 * day of the range.
 */
export function endOfDay(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}

export const listNotesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tag: tagFilterSchema,
  notebook: z.string().optional(),
  sort: noteSortSchema,
  order: noteOrderSchema,
  /** Inclusive date range, filtering the same column the sort uses. */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
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
  tag: tagFilterSchema,
  notebook: z.string().optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

/**
 * Export takes the note list's filters, so an export is the view the user was looking at.
 *
 * No `limit`: a partial backup is a trap rather than a feature. `sort` is accepted but
 * does not order anything — a zip of directories has no order worth choosing. It is here
 * because the date range filters whichever column the sort names, so without it an export
 * of "2021" would quietly mean a different set of notes than the list showing "2021".
 */
export const exportQuerySchema = z.object({
  tag: tagFilterSchema,
  notebook: z.string().optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  sort: noteSortSchema,
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

/**
 * One note from a sync-based import, still in Evernote's own markup.
 *
 * The ENEX path converts ENML to Markdown on the client, because the browser is already
 * holding the file and conversion there costs the server nothing. A syncing client has no
 * such converter — it would have to reimplement `enmlToMarkdown` in its own language, and
 * the second implementation would drift from the first. So it posts ENML and the server
 * converts, keeping one definition of what Evernote's markup means.
 *
 * Resources are metadata only. The converter needs `md5` to rewrite `<en-media hash>` into
 * a `files/` link, and the filename to point at, but not the bytes — those are far larger
 * than the note and go through the normal attachment route afterwards.
 */
export const importEnmlSchema = z.object({
  title: z.string().max(MAX_TITLE_LENGTH).default(''),
  enml: z.string().max(MAX_ENML_BYTES).default(''),
  tags: z.array(tagNameSchema).max(100).default([]),
  notebook: notebookNameSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  sourceEnex: z.string().max(255).optional(),
  sourceUrl: z.string().max(2000).optional(),
  resources: z
    .array(
      z.object({
        /** Lowercase hex md5 of the decoded bytes — what `<en-media hash>` refers to. */
        md5: z.string().regex(/^[0-9a-f]{32}$/),
        filename: z.string().min(1).max(255),
        mime: z.string().max(255),
      }),
    )
    .max(200)
    .default([]),
});

export type ImportEnmlInput = z.infer<typeof importEnmlSchema>;

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
