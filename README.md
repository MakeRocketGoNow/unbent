# Unbent

A personal note app that keeps your notes in Markdown and hands them back whenever you ask.

Notes are Markdown with YAML frontmatter. Attachments are ordinary files. Export produces a
plain folder tree — one directory per note, containing `note.md` and a `files/` subdirectory —
that you can read, grep, and back up without this app existing.

The Markdown is the note, not a serialization of one. A note you save is byte-identical to
what you typed: no reflowed lists, no `_italic_` quietly rewritten to `*italic*`, no escaped
underscores in a filename. That is the whole promise, and it is what makes the export
guarantee worth anything — a format the app rewrites behind your back is a format you do not
actually own.

Editing it should still feel like a word processor. See [Editing](#editing).

## Why

Evernote's owner gave a lot of people a reason to leave. Leaving should be easy, and staying
should never depend on it being hard.

## Stack

- **Cloudflare Workers** + Hono — API, and static-asset hosting for the SPA
- **TanStack Router + Query** — real routes, typed search params, cached loaders
- **Cloudflare D1** (SQLite) — note text, metadata, FTS5 full-text search
- **Cloudflare R2** — attachment blobs
- **Better Auth** — OAuth (Google, GitHub)
- **Vite + React + CodeMirror 6** — Markdown editor, styled in place (see [Editing](#editing))

One Worker serves both the built SPA and `/api`, so the two are genuinely same-origin and
the session cookie needs no CORS or `SameSite` workarounds.

Workers Paid ($5/mo) is wanted for the free tier's 100k requests/day, not for CPU. Import
posts one note at a time (plus one request per attachment), so a large migration can
exhaust a day's free quota on its own. CPU is not the constraint at either end: ENEX
parsing runs in a browser Web Worker rather than on Workers, and export streams the zip as
the client consumes it.

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

## Deployment

Production lives at `https://unbent.app` under the `production` environment in
`apps/api/wrangler.toml`. It is a named environment rather than edited top-level values so
that `wrangler dev` cannot pick up production settings, and a deploy cannot ship a
localhost `APP_URL` — `auth.ts` keys secure cookies off that string, so a wrong value
breaks every session and only shows up after the deploy.

Wrangler is a devDependency of `apps/api`, not a global install — the lockfile pins the
version the config is known to work with, and a global copy would silently override it.
`pnpm exec` from that directory runs the pinned one; `npx` from the repo root does not, and
downloads a different version instead.

First time, in order:

```bash
cd apps/api
pnpm exec wrangler login
pnpm exec wrangler d1 create unbent   # paste the id into [[env.production.d1_databases]]
pnpm exec wrangler r2 bucket create unbent-blobs
pnpm migrate:remote                   # from the repo root
```

Then the secrets. `--env production` is required on every one: secrets are per-environment,
and one set without it lands on a Worker that is not the one serving the site.

```bash
cd apps/api
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env production   # openssl rand -base64 32
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env production
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env production
pnpm exec wrangler secret put ALLOWED_EMAILS --env production       # comma-separated
```

`ALLOWED_EMAILS` is what keeps a public URL from becoming a free notes host: sign-in is
OAuth only, so without it anyone with a Google or GitHub account can create an account.
It is a secret rather than a var only to keep the address list out of the repo.

OAuth callbacks have to be registered against the real origin before anyone can sign in,
including you:

- Google: `https://unbent.app/api/auth/callback/google`
- GitHub: `https://unbent.app/api/auth/callback/github`

Then deploy. `custom_domain = true` means Cloudflare creates and manages the DNS record and
certificate, so there is nothing to add by hand:

```bash
pnpm deploy
```

## Auth

Better Auth with OAuth only — Google and GitHub. A provider without configured credentials
is simply not offered, so local development works with none of them set.

Sessions are cookie-based and same-origin. Better Auth enforces CSRF by requiring a trusted
`Origin`, so API clients outside the browser must send one.

## Editing

**The goal is WYSIWYG.** Bold looks bold, headings are sized, task lists get real
checkboxes, attachment images render inline, and tables are edited with buttons rather
than by hand. Markdown is the storage format, not the interface — nobody should have to
count pipe characters to add a column.

What we will not do is get there the usual way.

### Why not a document model

The standard WYSIWYG approach parses Markdown into its own document model, holds that
model as the source of truth, and re-serializes on save. The round trip is where notes get
damaged. TipTap 3, run against real notes from this corpus, turns `](<files/My File.pdf>)`
into a broken link, escapes underscores in filenames, and normalizes `_italic_` to
`*italic*`. None of those edits were asked for. Each one is a small, silent, permanent
rewrite of a file the user believes they own.

That is disqualifying here, and not only on aesthetic grounds: a broken attachment link is
a note whose PDF no longer resolves, and this archive is mostly PDFs.

So the real constraint is narrower than "no WYSIWYG":

> **The document text is the only source of truth, and every edit is an ordinary text edit
> the user could have typed by hand.**

WYSIWYG *behavior* is entirely compatible with that. WYSIWYG *architecture* — a parallel
document model that owns the truth — is not.

### How it works instead

CodeMirror 6 edits the Markdown directly, with a rich mode that styles the source in
place. Syntax characters hide unless the cursor is inside the node they belong to, so
reading stays clean and editing stays direct. The text never leaves the buffer, so there
is no parse-and-reserialize step in which it could be rewritten.

Every affordance is built on top of that rather than around it:

- A toolbar and the usual shortcuts (⌘B, ⌘I, ⌘K, ⌘⌥1) apply formatting as text edits.
- Tab and Shift-Tab indent and outdent list items; outside a list Tab moves focus as
  usual, so the editor is never a keyboard trap.
- Tables get a toolbar anchored to the table the cursor is in — insert and delete rows and
  columns, set column alignment, and a grid size picker for creating one. Restructuring a
  Markdown table by hand means editing every row plus the delimiter, so the tedious
  operations get buttons; each one is still a plain edit through
  `apps/web/src/editor/markdown-commands.ts`, which rewrites the table's text and lets
  CodeMirror's history record it as a single undo step.
- Dragging a file in shows a drop cursor at the exact insertion point.

The test for any new editing feature is the same one every time: **can it be expressed as
an edit to the text, undone with a single ⌘Z, and retyped by hand to the same result?** If
yes, it belongs, however rich it looks. If it needs a parallel document model, it does
not, however convenient that would be.

Rendering uses GFM (tables, task lists, strikethrough, autolinks) plus soft line breaks:
a single newline is a line break, not a space. CommonMark folds lone newlines into spaces,
which turns a note written as separate lines into one run-on paragraph — pressing Enter in
a notes app should start a new line. Soft breaks are not part of GFM itself; they are a
separate remark plugin.

### Still to build

Toward the same goal, under the same constraint: inline image resizing, a link editor that
does not require selecting the whole `[]()`, and drag-to-reorder for list items.

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

### Filtering and sorting

Search takes the same `tag`, `notebook`, `from`, and `to` filters as the note list, so
typing a query narrows the current view instead of escaping it — with a notebook selected,
"insurance" means "insurance in here". The clauses are shared by `list`, `count`, and
`search` through one helper so a filter cannot come to mean two different things, and they
apply inside both search CTEs: the note index and the attachment-text index each join
`notes` separately, so scoping only one would still surface notes from outside the filter.

The list is ordered by `sort` (updated, created, title) and `order`. Search is not: results
come back ranked by relevance, and reordering them by date discards the ranking that makes
them worth showing, so the sort control is hidden while searching.

Sorting and keyset pagination have to agree — the cursor compares against the column that
ordered the query, so `SORTS` in `apps/api/src/lib/notes-repo.ts` pairs each sort with its
column and its cursor rather than leaving the route to know which is which. The cursor also
carries the row id, because comparing the sort key alone is only safe when it is unique and
titles are not: an archive is full of notes called "Receipt", and paging nine identically
titled notes returns four without the tiebreak.

Date bounds are `YYYY-MM-DD`, inclusive at both ends, read in UTC to match the epoch-ms
columns. The range filters whichever column the sort uses, so the filter and the order
always mean the same date; search, having no sort, filters on `created_at`.

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
- **Sweep orphaned files** — removes R2 objects with no attachment row. Files you
  unlinked from a note still have a row; delete those from the note’s Attachments list.
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

`/api/export` also takes the note list's `tag`, `notebook`, `from`, and `to`, so an export
can be a slice rather than the whole library — a year of records for a doctor, the receipts
an accountant asked for. The enumeration goes through the same `notes.list` as the list
itself, so a filter cannot mean one thing on screen and another in the zip. There is no
`sort` (a directory tree has no order worth choosing) and no `limit` (a partial backup is a
trap); `sort` is accepted only to say which column a date range applies to. The filename
carries the scope, since several slices land in one downloads folder on the same day.

This is the backup mechanism, not a convenience feature: `wrangler d1 export` fails on any
database containing an FTS5 table and leaves the database wedged in a "processing export"
state ([workers-sdk#9519](https://github.com/cloudflare/workers-sdk/issues/9519)). Do not
run it.
