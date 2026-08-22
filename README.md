# Unbent

A personal note app that keeps your notes in Markdown and hands them back whenever you ask.

Notes are Markdown with YAML frontmatter. Attachments are ordinary files. Export produces a
plain folder tree — one directory per note, containing `note.md` and a `files/` subdirectory —
that you can read, grep, and back up without this app existing.

## Why

Evernote's owner gave a lot of people a reason to leave. Leaving should be easy, and staying
should never depend on it being hard.

## Stack

- **Cloudflare Pages** — SPA hosting
- **Cloudflare Workers** + Hono — API
- **Cloudflare D1** (SQLite) — note text, metadata, FTS5 full-text search
- **Cloudflare R2** — attachment blobs
- **Better Auth** — OAuth (Google, GitHub)
- **Vite + React + CodeMirror 6** — Markdown editor with live preview

Workers Paid ($5/mo) is required: the free tier's 10ms CPU limit cannot run import or export.

## Layout

```
apps/web       Vite + React SPA
apps/api       Hono API on Workers
packages/shared  zod schemas, frontmatter codec, remark plugins
packages/enex    ENEX -> Markdown, runtime-agnostic
```

## Development

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then set BETTER_AUTH_SECRET
pnpm migrate:local
pnpm dev
```

The SPA runs on :5173 and proxies `/api/*` to the Worker on :8787, so sessions are same-origin
and there is no CORS in development.

## Auth

Better Auth with OAuth only — Google and GitHub. A provider without configured credentials
is simply not offered, so local development works with none of them set.

Sessions are cookie-based and same-origin. Better Auth enforces CSRF by requiring a trusted
`Origin`, so API clients outside the browser must send one.

## Editing

CodeMirror 6 editing markdown, with a rich mode that styles the source in place — bold
looks bold, headings are sized, task lists get real checkboxes, and attachment images
render inline. Syntax characters hide unless the cursor is inside the node they belong to,
so reading stays clean and editing stays direct.

This is deliberately not a WYSIWYG editor. A WYSIWYG parses markdown into its own document
model and re-serializes on save, which rewrites text it was never asked to touch: TipTap 3
turns `](<files/My File.pdf>)` into a broken link, escapes underscores in filenames, and
normalizes `_italic_` to `*italic*`. Here the text never leaves the buffer, so a stored
note is byte-identical to what was typed — which is what makes the export guarantee real.

A toolbar and the usual shortcuts (⌘B, ⌘I, ⌘K, ⌘⌥1) apply formatting as ordinary text
edits, so every action is undoable and nothing is rewritten behind your back.

## Search

FTS5 over note titles and bodies, weighted 10:1 toward titles. The index is
external-content (`content='notes'`), so it references the notes table rather than storing
a second copy of every body.

Rows must be removed from the index with FTS5's `'delete'` command carrying the old column
values. A plain `DELETE FROM notes_fts` does not error — it silently corrupts the index,
and the damage surfaces later as edited or deleted notes still matching their old text.
`test/search.test.ts` asserts this directly; introducing the plain-DELETE form makes three
of those tests fail.

To rebuild the index from scratch: `INSERT INTO notes_fts(notes_fts) VALUES('rebuild');`

### Editing

CodeMirror 6 editing markdown, with a rich mode that styles the source in place — bold
looks bold, headings are sized, task lists get real checkboxes, and attachment images
render inline. Syntax characters hide unless the cursor is inside the node they belong to,
so reading stays clean and editing stays direct.

This is deliberately not a WYSIWYG editor. A WYSIWYG parses markdown into its own document
model and re-serializes on save, which rewrites text it was never asked to touch: TipTap 3
turns `](<files/My File.pdf>)` into a broken link, escapes underscores in filenames, and
normalizes `_italic_` to `*italic*`. Here the text never leaves the buffer, so a stored
note is byte-identical to what was typed — which is what makes the export guarantee real.

A toolbar and the usual shortcuts (⌘B, ⌘I, ⌘K, ⌘⌥1) apply formatting as ordinary text
edits, so every action is undoable and nothing is rewritten behind your back.

## Searching inside PDFs

Most notes in a real Evernote export are a scanned PDF with an empty body — in one notebook,
90 of 108 sampled notes had zero body text. Searching note text alone would never find them.

Evernote already ran OCR on those scans and embedded the text layer, so the import extracts
it with pdf.js rather than re-OCRing: about 80% of real scans yield usable text, median ~8k
characters. It lands in `attachment_text`, indexed by its own FTS5 table, and search unions
both indexes — note matches rank above attachment matches, and a hit from a file reports
which file it came from.

Roughly a fifth of scans produce character noise instead of language (`> CO 5 I > — O —`).
Those are filtered out rather than indexed. Much of the usable text is letter-spaced
(`H a r b o r v i e w`), which is rejoined so the word is actually findable.

**Backfill.** Import is idempotent on content hash, so notes imported before extraction
existed cannot be fixed by re-importing — they are skipped along with their attachments.
"Index existing PDFs" in the Import panel walks the gap instead, extracting text for any
attachment that does not have it yet.

## Local database

`pnpm --filter @unbent/api db:reset` rebuilds the local D1 from migrations, copying the
current state into `.wrangler/backups/` first. Use it instead of removing the state
directory by hand — that has no undo and has already cost one set of local notes.

## Deleting notes

Note deletion in the app is a soft delete — the note goes to trash and its attachments stay
in R2 so a restore is not left with dead links. To reclaim that storage, the Import panel
has a Maintenance section:

- **Empty trash** — permanently deletes soft-deleted notes and their files.
- **Sweep orphaned files** — removes R2 objects with no attachment row.
- **Delete all notes** — wipes every note and attachment in the account. Requires typing
  `DELETE`, since it is irreversible and export is the only way back.

The API equivalents are `POST /api/admin/purge-notes?scope=trashed|all&confirm=DELETE` and
`POST /api/admin/gc-blobs?apply=1`. Both are scoped to the caller's own data.

For local development, `pnpm --filter @unbent/api reset:local` clears D1 and R2 entirely and
rebuilds the schema, backing up D1 first. Use that rather than the in-app sweep to clear
fixtures left by deleted test users — the scoped sweep cannot reach another account's
prefix by design.

## Blob garbage collection

R2 has no foreign keys, so objects can outlive their metadata — a crash between the upload
and the metadata insert, or a user row cascading away its attachment rows. `POST
/api/admin/gc-blobs` sweeps the caller's own prefix and reports what it finds; add
`?apply=1` to delete. It is scoped to `users/{caller}/` by design, so it can never see or
remove another account's objects.

## Known gaps

- **Trash is never purged.** Note deletion is a soft delete, and the note's attachments
  stay in R2 so a restore is not left with dead links. Nothing reclaims that storage yet;
  a trash purge needs to delete the rows and their blobs together.
- **Deleting a user strands its blobs.** The D1 rows cascade, but the objects under
  `users/{id}/` remain and the scoped sweep above cannot reach them once the account is
  gone. Account deletion needs to sweep the prefix before removing the user row.

## Tenant isolation

D1 has no row-level security, so isolation is application code and nothing else. Data access
goes through the scoped repos in `apps/api/src/lib/repo.ts`, which take the user id as a
constructor argument — route handlers never touch `env.DB` directly, so an unscoped query is
not expressible. `apps/api/test/isolation.test.ts` asserts this and grows with every phase
that adds a route touching user data.

## Backups and export

`GET /api/export` streams a zip of the whole account as a plain folder tree:

```
first-note-2382e420/note.md
untitled-e080eb5b/note.md
```

Each `note.md` is markdown with YAML frontmatter (id, title, created, updated, tags). The
directory name is a slug plus an id fragment, so two notes with the same title do not
collide. Standard `unzip` reads it; no part of this app is needed to get your notes back.

This is the backup mechanism, not a convenience feature: `wrangler d1 export` fails on any
database containing an FTS5 table and leaves the database wedged in a "processing export"
state ([workers-sdk#9519](https://github.com/cloudflare/workers-sdk/issues/9519)). Do not
run it.
