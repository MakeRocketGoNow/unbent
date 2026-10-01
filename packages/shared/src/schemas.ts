/**
 * Runtime validation shared by the Worker and the SPA. Each schema is simultaneously the
 * API contract and the TypeScript type, so the two cannot drift.
 */
import { z } from 'zod';
import { dateOnlySchema } from './dates.js';
import {
  MAX_FIELD_NAME_LENGTH,
  fieldValueInputSchema,
  noteFieldsPatchSchema,
  parseFieldFilter,
  type FieldDef,
  type FieldValue,
  type NoteFieldValue,
} from './fields.js';

// The date helpers live in their own module so the field codec can use them without a
// cycle; re-exported here so nothing that imported them from the schemas notices.
export { dateOnlySchema, startOfDay, endOfDay } from './dates.js';

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
export const MAX_NOTEBOOK_PURPOSE_LENGTH = 500;

/**
 * Attachment filenames are stored as the tail of an R2 object key:
 * `users/{userId}/notes/{noteId}/files/{attachmentId}-{filename}`.
 *
 * R2 caps a key at 1024 bytes, and that prefix costs about 130 with UUID-length ids.
 * 768 leaves room for the prefix, for the `-2`/`-999`/`-{8 hex}` suffix `availableFilename`
 * adds on collision, and for the multi-byte case: this is a byte budget, while the check
 * below counts UTF-16 code units, so a name of CJK or accented characters can cost up to
 * three times its length. The earlier 255 was the POSIX `NAME_MAX` default rather than a
 * limit anything here imposes — nothing writes these to a filesystem, and the D1 column is
 * TEXT — and it rejected real Evernote attachments whose display label was a sentence.
 */
export const MAX_FILENAME_LENGTH = 768;

/** Rejects path separators and traversal so a filename can never escape its note prefix. */
export const filenameSchema = z
  .string()
  .min(1)
  .max(MAX_FILENAME_LENGTH)
  .refine((n) => !n.includes('/') && !n.includes('\\'), 'Filename may not contain path separators')
  .refine((n) => n !== '.' && n !== '..', 'Invalid filename')
  .refine((n) => !n.startsWith('.'), 'Filename may not start with a dot');

export const tagNameSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

export const notebookNameSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

/**
 * A notebook's purpose: a sentence saying what belongs in it, shown to the person and read
 * by the auto-fill classifier. Unlike a name it may be blank, which clears it, so an empty
 * or whitespace-only string normalises to `null` rather than being rejected.
 */
export const notebookPurposeSchema = z
  .string()
  .trim()
  .max(MAX_NOTEBOOK_PURPOSE_LENGTH)
  .transform((v) => (v.length > 0 ? v : null))
  .nullable();

/**
 * Room for the longest emoji a person can pick, not for a word. A family with a skin tone
 * on each member or a subdivision flag is one picture built from a dozen or more code
 * points, and 32 UTF-16 units clears the longest of those with margin.
 */
export const MAX_NOTEBOOK_EMOJI_LENGTH = 32;

/*
   A grapheme is an emoji when it holds a pictograph, a regional indicator (half of a
   country flag) or a keycap mark (the enclosing square of 1️⃣ and #️⃣). Testing for any
   of those rather than for `\p{Emoji}` is deliberate: `\p{Emoji}` also matches the plain
   digits 0–9 and `#` and `*`, which would let a bare "7" through as a notebook's icon.
*/
const EMOJI_PART = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/**
 * Whether `value` is exactly one emoji: one user-perceived character, and a pictorial one.
 *
 * One grapheme because it is drawn where a single icon was, at the size of one: two emoji
 * or a word would overflow the square every row gives it. Counted with `Intl.Segmenter`
 * because a code-point or length count gets ZWJ sequences, flags and skin tones wrong —
 * 👩‍💻 is five code points and one picture.
 */
export function isSingleEmoji(value: string): boolean {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return graphemes.length === 1 && EMOJI_PART.test(value);
}

/**
 * A notebook's emoji, drawn in place of the book beside its name. Like a purpose it may be
 * blank, which clears it, so an empty string normalises to `null`; anything else must be a
 * single emoji (see `isSingleEmoji`).
 */
export const notebookEmojiSchema = z
  .string()
  .trim()
  .max(MAX_NOTEBOOK_EMOJI_LENGTH)
  .refine((v) => v.length === 0 || isSingleEmoji(v), 'Must be a single emoji')
  .transform((v) => (v.length > 0 ? v : null))
  .nullable();

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
 * The `field` filter, which may be given more than once — the same wire shape as `tag`.
 *
 * Each value is `<fieldId>:<op>[:<value>]`, read by `parseFieldFilter`; several narrow
 * conjunctively. Field definitions belong to a notebook, so this only means anything
 * alongside a `notebook` filter, but the server does not insist on it: a field id is
 * unique on its own, and a filter on a field from a notebook the list is not scoped to
 * simply matches nothing.
 */
export const fieldFilterSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]))
  .pipe(
    z
      .array(
        z.string().transform((raw, ctx) => {
          const parsed = parseFieldFilter(raw);
          if (!parsed) {
            ctx.addIssue({ code: 'custom', message: `Unreadable field filter: ${raw}` });
            return z.NEVER;
          }
          return parsed;
        }),
      )
      .max(10)
      .optional(),
  );

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
  /**
   * The error-tracking service this instance reports browser crashes to, if it has one.
   *
   * Absent means the SDK is never downloaded — it is imported dynamically on the strength
   * of this field, so an instance without it pays nothing for the feature and its privacy
   * policy does not mention it.
   *
   * `key` is the project's public write-only token, which is meant to ship in a page.
   * `uiHost` is where the service's own app lives, which the SDK needs told separately
   * because its API traffic is proxied through this Worker rather than sent direct.
   */
  posthog?: { key: string; uiHost: string };
  /**
   * The dev instance a preview borrows a Google session from, when this instance is a
   * preview at all.
   *
   * Present only on a per-PR preview, whose own hostname changes every PR and so can never
   * have an OAuth callback registered against it. `origin` is the standing dev instance —
   * e.g. `https://dev.unbent.app` — that a preview's login screen sends people to to sign
   * in, and which redirects them back with a one-time token. Absent everywhere else,
   * including production and the dev instance itself, which have their own sign-in and read
   * this as "draw no relay button". See `previewRelayOrigin` in the API.
   */
  previewRelay?: { origin: string };
  /**
   * Whether this instance can fill in a note's filing from what it says.
   *
   * On when the operator has set a Jev key — `TYPESAFE_API_KEY` in the API — and the
   * editor draws the Auto-fill control on the strength of this alone, since the route
   * answers 503 without one. Optional for the same reason `accountDeletion` is: absent
   * reads as not offered.
   */
  autofill?: boolean;
  /**
   * Whether this instance reads images — and scans with no text layer — with a vision
   * model, so they can be searched and auto-filled.
   *
   * On when the operator has set `ANTHROPIC_API_KEY` in the API. Maintenance offers its
   * "Read N images" pass only when this is true, since each file read is a paid
   * request the instance has to be able to make.
   */
  vision?: boolean;
  /**
   * This instance is a pull-request preview with note stores of its own, because its PR
   * changes the store and only its own stores run that code. They start empty, so the
   * page offers to fill them with sample notes; and the files bucket is shared with the
   * dev instance, so Maintenance leaves out the orphaned-file sweep, which would see every
   * file of the dev instance's as an orphan here. Absent everywhere else, including on a
   * preview that reads the dev instance's stores.
   */
  ownStores?: boolean;
  /**
   * What this instance is, when it is not the one people use — "Dev", "PR 222", "Local".
   * The page puts it in front of the tab title, badges the favicon, and names it in the
   * account menu, so a tab of a scratch instance cannot be mistaken for the real one, or
   * the real one for scratch. Absent on production, which draws none of it.
   */
  instanceLabel?: string;
  /**
   * Which kind of instance the label names, for the colour of its marks and whether the
   * drawer carries a corner ribbon: `dev` and `preview` do, `local` keeps to the quieter
   * marks. Absent with the label on production, and on an instance whose setting is not
   * one of the three.
   */
  instanceKind?: InstanceKind;
}

export const INSTANCE_KINDS = ['dev', 'preview', 'local'] as const;
export type InstanceKind = (typeof INSTANCE_KINDS)[number];

/**
 * What auto-fill proposes for a note, as `POST /notes/:id/autofill` answers.
 *
 * Suggestions, never writes. The editor holds a draft and an autosave, and a server that
 * wrote behind them would be undone by the next keystroke — the hazard the web's
 * `open-note-fields.ts` describes. So the server judges and the client applies, which is
 * also what lets the client fill what is empty at once and ask before replacing anything
 * already set.
 *
 * Each part carries the model's confidence in it, 0 to 1, already above the floor the
 * server applies — anything below is not returned at all. It rides along so a client can
 * show it, or hold a low one back further than the server did.
 */
export interface AutofillSuggestion {
  /**
   * `confidence` is absent when the title was written by the language model rather than
   * chosen by Jev from the document's lines: a model that writes reports no probability.
   */
  title?: { value: string; confidence?: number };
  /** An existing notebook the note belongs in. */
  notebook?: { id: string; name: string; confidence: number };
  /** Existing tags that apply, likeliest first. Tags the note already carries are left out. */
  tags: Array<{ name: string; confidence: number }>;
  /**
   * Values for the fields of the notebook the note would end up in — the suggested one,
   * or the note's own when there is no suggestion. Each carries its definition, so a
   * client can write the value before it has loaded that notebook's fields.
   */
  fields: Array<{ field: FieldDef; value: FieldValue; confidence: number }>;
  /** Which of the note's files were read, and which had no text to read yet. */
  read: { attachments: string[]; pending: string[] };
  /**
   * A standing fault in the language model the title is written by, surfaced only to an
   * operator and only when it is one the operator has to fix — an API key the model
   * rejected, or a model this key cannot use. Not a transient outage: a rate limit or a
   * 5xx leaves this absent and Jev's picked title stands, because retrying would work.
   *
   * `'auth-failed'` is the key case — a 401/403 from the model, which fails every call
   * until the key is replaced, and looks in the UI exactly like "the model had no better
   * title" without this. Absent for a non-operator, or where the title call succeeded,
   * declined, or failed only for a moment; see the API's `lib/autofill.ts`.
   */
  titleModel?: 'auth-failed';
}

export const noteIdSchema = z.string().uuid();

/**
 * Files to copy into a note from another note of the same user's.
 *
 * `from` is not `noteIdSchema`: imported notes keep the ids their export carried, which
 * need not be UUIDs, and ownership is what the repo checks anyway. `move` deletes each
 * source file once it is copied — but only one the source body no longer links, so a
 * paste after a cut that has not yet saved falls back to a copy rather than taking a file
 * the source still shows.
 */
/** A web image to fetch into a note as an attachment; the Worker checks the address. */
export const fetchWebImageSchema = z.object({
  url: z.string().min(1).max(2048),
});

export const copyAttachmentsSchema = z.object({
  from: z.string().min(1).max(128),
  filenames: z.array(filenameSchema).min(1).max(200),
  move: z.boolean().default(false),
  /**
   * Also append a markdown link for each copied file to the destination body, for a
   * caller with no editor open on that note — the panel's copy-to. The editor's paste
   * writes its own links and leaves this off, as the upload's `?link=1` does.
   */
  link: z.boolean().default(false),
});

export const createNoteSchema = z.object({
  title: z.string().max(MAX_TITLE_LENGTH).default(''),
  body: z.string().max(MAX_BODY_BYTES).default(''),
  tags: z.array(tagNameSchema).max(100).default([]),
  notebook: notebookNameSchema.nullable().optional(),
  /** Custom field values by field id. See `noteFieldsPatchSchema`. */
  fields: noteFieldsPatchSchema.optional(),
});

export const updateNoteSchema = z.object({
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
  body: z.string().max(MAX_BODY_BYTES).optional(),
  tags: z.array(tagNameSchema).max(100).optional(),
  notebook: notebookNameSchema.nullable().optional(),
  /** Merged into the note's values: absent keys are untouched, null clears one. */
  fields: noteFieldsPatchSchema.optional(),
});

/**
 * A set of notes to act on at once: the list's selection.
 *
 * Ids rather than a filter, deliberately. "Every note matching the filter" would let a
 * client trash what it has not seen — the list is paged, and a filter that reads as forty
 * rows on screen can match four thousand — whereas a client that names ids can only name
 * what it has loaded. The cap is generous next to the pages the list loads; it exists so a
 * request stays one request rather than a job.
 *
 * Any non-empty string is an id here, not only a UUID: an import keeps the id an export
 * carried when it can (`importNote`), so an archive can hold ids in another shape, and a
 * batch that refused them would refuse exactly the notes a bulk edit is for. An id that is
 * not this user's matches nothing, the same as it would in the singular routes.
 */
export const MAX_BATCH_NOTES = 500;

const noteIdsSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_BATCH_NOTES);

/** The notes a batch acts on — trash, restore, purge. */
export const noteBatchSchema = z.object({ ids: noteIdsSchema });

/**
 * A refiling applied to several notes: the notebook, and tags to add and take away.
 *
 * Tags are added and removed rather than set, because the notes need not agree: three
 * notes with three different tag lists gain a fourth tag each and keep their own. Setting
 * would make every list the same, which is never what "tag these" means. A tag in both
 * lists is added — the rule `update_note_tags` states over MCP. A body naming nothing to
 * change is refused rather than answered with a count of zero, since it is a client bug.
 */
export const updateNotesSchema = z
  .object({
    ids: noteIdsSchema,
    notebook: notebookNameSchema.nullable().optional(),
    addTags: z.array(tagNameSchema).max(100).optional(),
    removeTags: z.array(tagNameSchema).max(100).optional(),
  })
  .refine(
    (v) =>
      v.notebook !== undefined ||
      (v.addTags?.length ?? 0) > 0 ||
      (v.removeTags?.length ?? 0) > 0,
    { message: 'Nothing to change: give a notebook, tags to add, or tags to remove' },
  );

/**
 * How the note list is ordered.
 *
 * `created` is the default: this is a paperless archive more than a worklist, and a list
 * ordered by when each document arrived stays put — under `updated` an autosave, a tag or
 * an auto-fill sent an old receipt to the top, and the list reshuffled under whoever was
 * reading it. `updated` is still offered for working through what was touched last, and
 * `title` for finding a document by name.
 */
export const NOTE_SORTS = ['updated', 'created', 'title'] as const;
export type NoteSort = (typeof NOTE_SORTS)[number];

/** The order a list takes when none is asked for. Spelled once; see above for why. */
export const DEFAULT_NOTE_SORT: NoteSort = 'created';

export const noteSortSchema = z.enum(NOTE_SORTS).default(DEFAULT_NOTE_SORT);
/** Ascending is meaningful for every sort: oldest first, or A–Z. */
export const noteOrderSchema = z.enum(['asc', 'desc']).default('desc');

export const listNotesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tag: tagFilterSchema,
  notebook: z.string().optional(),
  field: fieldFilterSchema,
  sort: noteSortSchema,
  order: noteOrderSchema,
  /**
   * Sort by a custom field's value instead of `sort`. Wins over `sort` when both arrive;
   * `order` still applies. Notes without a value come last either way. The date range
   * then reads `updated_at`, as it does under the title sort — the rows show that date.
   * The web table's sortable field columns are what send this; the phone and the MCP
   * tool keep to the named sorts.
   */
  sortField: z.string().uuid().optional(),
  /** Inclusive date range, filtering the same column the sort uses. */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  /** List trashed notes instead of live ones. Any value but "1" is treated as false. */
  trashed: z
    .string()
    .optional()
    .transform((v) => v === '1'),
  /**
   * Count `total` from the notes themselves rather than read the stored count. For a
   * confirmation that names how many notes an action will destroy; everything else takes
   * the stored count, which costs one row instead of one per note. Same "1" rule.
   */
  exact: z
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
  field: fieldFilterSchema,
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  /**
   * Each match also carries its note's list row — fields, tags, dates, files — as
   * `SearchResultRow`, for a table drawing the search in its columns. Off by default: the
   * sidebar's results draw a title and a snippet, and the row costs a read of every
   * match's tags, fields and files. Same "1" rule as `exact`.
   */
  rows: z
    .string()
    .optional()
    .transform((v) => v === '1'),
});

/**
 * Export takes the note list's filters, so an export is the view the user was looking at.
 *
 * No `limit`: a partial backup is a trap rather than a feature. `sort` orders nothing
 * anyone sees — a zip of directories has no order worth choosing. It is here because the
 * date range filters whichever column the sort names, so without it an export of "2021"
 * would quietly mean a different set of notes than the list showing "2021"; and, for the
 * paged export, because it is the column the cursor walks.
 */
export const exportQuerySchema = z.object({
  tag: tagFilterSchema,
  notebook: z.string().optional(),
  field: fieldFilterSchema,
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  sort: noteSortSchema,
});

/**
 * One page of an export: the same filter, walked with a cursor. The archive is built by
 * the client from these pages (see the web app's `export-archive.ts`), because a Worker
 * request may make only so many database calls and a library is thousands of notes.
 */
export const exportPageQuerySchema = exportQuerySchema.extend({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * One note from an ENEX import. `contentHash` makes the endpoint idempotent so an
 * interrupted import can be re-run without duplicating notes.
 */
export const importNoteSchema = z.object({
  /**
   * The id the note had where it came from, when the source was another Unbent.
   *
   * An export writes each note's id into its frontmatter, and a restore should put the
   * note back at the same address: bookmarks, links from other notes and anything an MCP
   * client remembered keep working. It is also the only reliable way to tell "this note is
   * already here" — a note created in the editor has no content hash to match on, and one
   * edited since the export would not match anyway. The server keeps it when it is free
   * and mints a fresh one otherwise, so it is a request, not a claim.
   */
  id: noteIdSchema.optional(),
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
  /**
   * Custom field values keyed by field *name*, the interchange form, resolved against the
   * note's notebook on the way in; a name with no definition creates one. Keys are only
   * length-checked here so that one reserved or unreadable value skips that field rather
   * than failing the whole note — the import reports what it skipped.
   */
  fields: z.record(z.string().max(MAX_FIELD_NAME_LENGTH), fieldValueInputSchema).optional(),
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
export type UpdateNotesInput = z.infer<typeof updateNotesSchema>;
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
  /** The notebook's id, for looking up its field definitions. Null when unfiled. */
  notebookId?: string | null;
  /** Custom field values, own notebook's first in definition order, then any foreign ones. */
  fields?: NoteFieldValue[];
  /**
   * The files the note stores, oldest first. Omitted when there are none.
   *
   * Name and declared type only: enough for a row to show what kind of thing is attached
   * and which one it is. The type is the stored value, unverified — fine for choosing a
   * glyph, which is all a row does with it.
   */
  attachments?: Pick<AttachmentInfo, 'filename' | 'contentType'>[];
  /** The body's prose, marks removed, for the row. Empty when the body has no prose. */
  excerpt?: string;
  /** When this note was trashed. Only present on notes listed from the trash. */
  deletedAt?: number;
}

export interface Note extends NoteSummary {
  body: string;
}

/** A notebook as the list reports it. */
export interface NotebookSummary {
  id: string;
  name: string;
  /** Live notes filed here. */
  count: number;
  /** Custom fields defined here. */
  fields: number;
  /** What belongs here, shown to the person and read by the classifier; `null` when unset. */
  purpose: string | null;
  /** Drawn in place of the book beside the name; `null` when unset, which draws the book. */
  emoji: string | null;
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
  /** Set when the match came from a custom field's value; the field's name. */
  matchedField?: string;
  /** Set when the match came from one of the note's tags; the tag's name. */
  matchedTag?: string;
}

/** A search match with the row the note list draws for that note; see `rows` on the query. */
export interface SearchResultRow extends SearchResult {
  note: NoteSummary;
}
