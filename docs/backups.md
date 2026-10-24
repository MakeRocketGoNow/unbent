# Backups and export

Settings → Export writes a zip of the whole account as a plain folder tree:

```
first-note-2382e420/first-note-2382e420.md
first-note-2382e420/files/agenda.pdf
first-note-2382e420/files/whiteboard.jpg
first-note-2382e420/text/agenda.pdf.txt
first-note-2382e420/described/whiteboard.jpg.txt
untitled-e080eb5b/untitled-e080eb5b.md
notebooks/coupons.yaml
```

Each markdown file carries YAML frontmatter (id, title, created, updated, tags, notebook,
and any custom field values by name) above the body exactly as written. The directory name
is a slug plus an id fragment, so two notes with the same title do not collide, and the
markdown repeats it so a search of the unpacked tree finds one file per title rather than a
thousand `note.md`s. Standard `unzip` reads it; no part of this app is needed to get your
notes back.

Beside `files/`, `text/`, `described/` and `written/` hold the text this instance holds for each
file, as a plain `<filename>.txt`: `text/` for what the file's own text layer gave,
`described/` for what the vision model read from a picture or a scan with no layer,
`written/` for what an assistant recorded over MCP after reading the picture itself. A file
with no text has none. They are what makes a scanned bill answerable, so they are also
what a person would want to `grep` in the unpacked folder, and without them a restore read
every file again, a PDF extraction or a paid vision request per file, and got different
words than search and Auto-fill had been built on.

`notebooks/` holds what is about a notebook rather than a note: one `<slug>.yaml` per
notebook with its emoji and its purpose when it has them (the purpose is what Auto-fill
files by, so a restore without it files differently) and its fields in order, each with its type and, where it has them, its select
or multi-select options with their colours (`colors:`, each option to a colour's name such as `green`, which import honours for the options it adds), its rating scale or its currency. A multi-select's value is a YAML list under the
field's name, the way `tags` is. A value in frontmatter says nothing about the field that holds it,
and without this file a restore rebuilt every field from the first value it met: URLs and
selects as text, ratings as plain numbers, and a field with no values not at all. An
unfiltered export lists every notebook, empty ones included; a filtered export lists the
notebooks its notes are in, plus the one the filter named.

The browser builds the archive. `GET /api/export/notes` hands back a page of whole notes
(body, tags, fields, and the names of their files) and the web app walks its cursor,
fetches each file through the note's own file route, and writes the zip with the names and
markdown that `packages/shared/src/export-format.ts` defines. It used to be one request
that streamed the whole zip, and that request read every note and every file from the
Worker as it went; a Worker request may make only so many calls to storage (a thousand on
Workers Free), and a library is tens of thousands of them, so the backup could never have
finished on the archive it existed for. In Chrome and Edge the zip streams straight to a
file the person chooses, so a library larger than the tab's memory still exports; other
browsers hold it in memory and hand it over as a download when it is done.

The page endpoint takes the note list's `tag`, `notebook`, `field`, `from`, and `to`, so an
export can be a slice rather than the whole library: a year of records for a doctor, the
receipts an accountant asked for. Settings → Notebooks offers the `notebook` slice as a
download beside each notebook, since "a copy of this notebook" is the slice people reach
for, and the note list offers the filter on screen beneath its filters. The enumeration
goes through the same `notes.list` as the list itself, so a filter cannot mean one thing on
screen and another in the zip. There is no order (a directory tree has no order worth
choosing); `sort` is accepted only to say which column a date range applies to. The filename
carries the scope, since several slices land in one downloads folder on the same day.

This is the backup in your own hands, not a convenience feature. It used to be the only
copy anywhere that held both the notes and their files; since October 2026 unbent.app's
daily dumps and nightly mirror hold both as well (see [Durability](architecture.md#durability)), but
those are the operator's, for a fault on the service's side, and they age out, so the
export is still the only copy a person holds and the only one that works on any
instance. An account's store dump (see [Where your notes live](architecture.md#where-your-notes-live))
has no files in it, and D1 has held no notes since the cutover. `wrangler d1 export`
works on D1 again, but what it exports is
sign-in, connected apps, upload links and the account directory. It used to refuse the
whole database because of the search tables, which have since moved into each account's
store, and a refused export left D1 answering every query with "processing export"
([workers-sdk#9519](https://github.com/cloudflare/workers-sdk/issues/9519)). So never put a
virtual table (FTS5 or any other) back in D1.

## Restoring, or moving to another Unbent

The same zip goes back in through Settings → Import, on the instance that wrote it or any
other, as does a single note's download, zip or bare `.md`. Every note's metadata is in its
own frontmatter, so a notebook exported with `?notebook=` arrives as that notebook, with its
tags, dates, custom fields and files; nothing about the notes lives outside the archive.

The `notebooks/` files are applied first, through `POST /api/import/notebook`, so values
land against the definitions they were written under. The rule there is add, never alter: a
field the notebook lacks is created as the file describes it, a field it already has keeps
its type and scale (changing either clears values, which an import should not decide), and
a select's or multi-select's options are merged. A notebook's emoji and purpose are set
when it has none and otherwise kept. A note's value naming an option the field
lacks adds that option rather than being dropped, so a vault with no `notebooks/` file still
lands with its choices intact. Anything left unapplied is named in the import's failure log.
An archive without `notebooks/` (an older export, a hand-made vault) imports as before,
with each field's type inferred from its first value. A single note's download carries no
definitions, since it is not a notebook.

Each note keeps the id it had when the id is free, so a restore puts notes back at their old
addresses and links between them keep working. A note that is already present (by id, or
by content hash for archives without ids) is skipped, so restoring a backup over a live
library duplicates nothing and never overwrites an edit made since. The trash is not
consulted: a note deleted on purpose stays deleted, and importing it again brings back a
fresh live copy under a new id.

The archive is read in the browser, one note and one attachment at a time, by the same
worker that reads ENEX files: the requests, the resumability and the per-note failure log
are all the ENEX import's. Attachment types are recovered from the bytes and then the
extension, since a zip carries neither. A file that arrives with a `text/`, `described/` or
`written/` sidecar is uploaded with `?text=supplied`, which stops the Worker reading it, and its text is
recorded as it was, under the reader that wrote it; nothing is extracted, nothing goes back
to pending, and no vision request is made. A file without one (from an older export) is
read as any upload is, so search works after that restore too. Only the layout is assumed: markdown with frontmatter, and a `files/` directory
beside it. Directory names are ignored, so an archive unpacked, rearranged and zipped again
by hand reads the same as the original.

## Importing from Notion

Notion's "Markdown & CSV" export (of a workspace, or of one database or page) goes in
through the same Settings → Import. The zip is read before anything is imported, and the
panel lists what it holds: one row per top-level database or page, with its notes, files
and columns counted, to tick or untick. The usual reason to untick is a database that is
already here from another source; the two Evernote-migrated notebooks in a real export
would otherwise arrive twice, since a note from Notion and the same note from ENEX share
no id and no hash.

Each database becomes a notebook, its rows the notes, and its columns the notebook's
fields. Notion's CSV carries no types, so each column's is inferred from every value it
holds, conservatively: Yes/No is a checkbox, a run of stars a rating, `$29.99` a number in
USD, short values that repeat a select, comma-separated parts that repeat a multi-select,
and anything the rules cannot place is text, which the Fields page can convert. A column
named Tags becomes the note's tags (an option under the list keeps it as a field), and
Notion's own created and last-edited columns become the note's dates: the one place the
export carries a timestamp; every other note is dated at import. A text column too long
for a field goes into the body under its own heading. Formulas and rollups are not in the
CSV and are dropped.

A page and its sub-pages become a notebook too, with any database nested in the tree
adding its columns; pages outside any database or tree go into one notebook named in the
panel, or none. Every page keeps Notion's id as its note id (the 32 digits are a UUID
without its dashes) so importing the same zip again skips what landed, and links between
exported pages, relative or `notion.so`, become links between the notes. Attachments sit
in a folder named for their page and are uploaded as the note's files; callouts become
quotes. The driver is `importNotion` in `packages/enex`, beside the ENEX and archive
importers, and shares their requests, resumability and failure log.

## Importing from Joplin

Joplin's JEX export (File → Export all → JEX in the desktop app, or Export → JEX on one
notebook) goes in through the same Settings → Import, with nothing to choose first. JEX is
taken rather than Joplin's Markdown + Front Matter export because it is Joplin's own
lossless backup: a tar of every note, notebook, tag and attachment record, each in the form
Joplin syncs, with the attachments' bytes in a `resources/` folder. The Markdown export has
no ids, renames the attachments, and is a folder that would have to be zipped first.

Every note keeps Joplin's id as its note id (32 hex digits, a UUID without its dashes), so
importing the same file again skips what landed, even a note edited in Joplin since. Its
dates are the ones Joplin shows (`user_created_time`, `user_updated_time`), its tags come
from the export's tag assignments, and its notebook is its Joplin notebook, a nested one
named for its whole path (`Household / Receipts`), since notebooks here do not nest. Links
of the form `:/<id>` become `files/` links to the note's attachments or links to the
imported notes; a resized picture's `<img>` becomes a markdown image; HTML notes (web
clips) go through the ENML converter. Notes in Joplin's trash are left out, and a note
exported still encrypted, or an attachment whose bytes are missing, is reported in the
failure log. The driver is `importJoplin` in `packages/enex`, reading the tar through a
small reader of its own (`tar.ts`).
