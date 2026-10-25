# Search and Auto-fill

## Search

FTS5 over note titles and bodies, weighted 10:1 toward titles. The index is
external-content (`content='notes'`), so it references the notes table rather than storing
a second copy of every body.

Rows must be removed from the index with FTS5's `'delete'` command carrying the old column
values. A plain `DELETE FROM notes_fts` does not error: it silently corrupts the index,
and the damage surfaces later as edited or deleted notes still matching their old text.
`test/search.test.ts` asserts this directly; introducing the plain-DELETE form makes three
of those tests fail.

To rebuild the index from scratch: `INSERT INTO notes_fts(notes_fts) VALUES('rebuild');`

### Filtering and sorting

Search takes the same `tag`, `notebook`, `from`, and `to` filters as the note list, so
typing a query narrows the current view instead of escaping it: with a notebook selected,
"insurance" means "insurance in here". The clauses are shared by `list`, `count`, and
`search` through one helper so a filter cannot come to mean two different things, and they
apply inside both search CTEs: the note index and the attachment-text index each join
`notes` separately, so scoping only one would still surface notes from outside the filter.

The list is ordered by `sort` (updated, created, title) and `order`. Search is not: results
come back ranked by relevance, and reordering them by date discards the ranking that makes
them worth showing, so the sort control is hidden while searching.

Sorting and keyset pagination have to agree: the cursor compares against the column that
ordered the query, so `SORTS` in `apps/api/src/lib/notes-repo.ts` pairs each sort with its
column and its cursor rather than leaving the route to know which is which. The cursor also
carries the row id, because comparing the sort key alone is only safe when it is unique and
titles are not: an archive is full of notes called "Receipt", and paging nine identically
titled notes returns four without the tiebreak.

Date bounds are `YYYY-MM-DD`, inclusive at both ends, read in UTC to match the epoch-ms
columns. The range filters the date the sort's rows show (updated or created, and updated
under the title sort, which has no date of its own) so the filter and the row always mean
the same date; search, having no sort, filters on `created_at`.

### Acting on several notes

The list has a selection, in the shape people arrive with from Evernote. Cmd/Ctrl-click
toggles a note into it (the open note comes along with the first) and Shift-click selects
a run from the last one picked (or from the open note); on a touch screen a finger resting on a note for half a second selects it, and
while anything is selected a tap toggles notes rather than opening them. Space picks the
focused note, Cmd/Ctrl+A picks every loaded note, Escape clears. The table view has a
column of checkboxes with a select-all in its header as well. A bar floats up over the foot
of the screen with the count and the actions: move to a notebook (an existing one, or a
name that makes a new one), add or take away tags, delete. In the trash the same selection
restores or permanently deletes. Opening a note or changing the filters drops the
selection, so an action can never reach notes that are out of view, and Select all reaches
what is loaded, not what the filter would match.

The API is `PATCH /api/notes` with `{ ids, notebook?, addTags?, removeTags? }`, and
`POST /api/notes/trash`, `/api/notes/restore` and `/api/notes/purge` with `{ ids }`. Each
answers with a count. A note already in the notebook, or already carrying the tag, is left
alone and keeps its date; ids that are not the caller's, or on the wrong side of the trash,
are counted out rather than failing the request. Up to 500 ids per call.

## Searching inside PDFs

Most notes in a real Evernote export are a scanned PDF with an empty body: in one notebook,
90 of 108 sampled notes had zero body text. Searching note text alone would never find them.

Evernote already ran OCR on those scans and embedded the text layer, so the import extracts
it with pdf.js rather than re-OCRing: about 80% of real scans yield usable text, median ~8k
characters. It lands in `attachment_text`, indexed by its own FTS5 table, and search unions
both indexes: note matches rank above attachment matches, and a hit from a file reports
which file it came from.

Roughly a fifth of scans produce character noise instead of language (`> CO 5 I > — O —`).
Those are filtered out rather than indexed. Much of the usable text is letter-spaced
(`H a r b o r v i e w`), which is rejoined so the word is actually findable.

**When it runs.** The editor extracts text from a PDF the moment its upload returns, from the
bytes already in hand, so a file dropped into a note is searchable seconds later. The Android
app does the same for a capture by loading `/embed/index-files?note=…` in a WebView nobody
sees: the site's own extractor, run by the phone for the one note it just made. And the
app runs a pass over whatever is still pending each time it opens, so a file either of those
missed is caught the next time anyone looks.

**On the server, where it can.** unbent.app binds Workers AI, and the upload handler hands a
PDF to its document conversion after the response is sent, then records the text itself, so
every client gets a searchable PDF without doing anything, and the editor, the import and the
phone skip their own extraction when the upload says `indexing: "server"`. The conversion
reads the text layer, as pdf.js does; measured on fifty scans from a real export, the two agree
on which files have text and which have none, with a median word overlap of 0.89. Its output
opens with the file's metadata (PDF version, the scanner's name), which is stripped before
indexing, or every scan from the same scanner would match a search for it. Files over 25MB, a
deployment without the binding, and any failure fall back to the browser paths above; only a
conversion that read the file and found nothing closes the row. The binding is on every deployed
instance and left out of the `local` environment in `wrangler.toml`, since a `wrangler dev`
with it needs a Cloudflare login to start, so local development keeps extracting in the
browser.

That pass stops short of a backlog: more than one page of pending files and it downloads
nothing, because it pulls the same bytes the button does and a backlog is gigabytes that must
not start flowing because a tab was opened on a phone. The sidebar says what it left, and
"Index existing PDFs" on the Maintenance page is where that gets run.

**Backfill.** Import is idempotent on content hash, so notes imported before extraction
existed cannot be fixed by re-importing: they are skipped along with their attachments.
"Index existing PDFs" walks the gap instead, extracting text for any attachment that does
not have it yet. `GET /api/attachments/pending-text` says what is still missing, scoped to
one note with `?note=`, which is how the phone asks for its own capture and nothing else.

### Reading images

A text layer is the only text a file had, so a photo of a receipt, a business card, a plate
of food or a whiteboard was nothing to search and nothing for Auto-fill to read, and so was
a scan that was never OCR'd. With an Anthropic API key, Auto-fill reads those with a vision
model:

```bash
cd apps/api
pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

Locally, the same name in `apps/api/.dev.vars`; `DEV_ANTHROPIC_API_KEY` as a GitHub secret
carries a separate key to the dev instance and previews. Without one, pictures have no text,
as before, and nothing is sent anywhere.

The model is asked for one fixed shape (a short name for the file, what kind of thing it is,
a sentence or two on what it shows and the facts someone filing it would want, and every
legible word transcribed) and the whole of it becomes the file's text, in that order. The
same row search indexes and Auto-fill reads, so a photo of a card fills a Contacts notebook's
fields the way a scan fills Receipts, and "lasagna" finds the plate. `get_attachment_text`
over MCP returns it too.

**When it runs: only when someone presses Auto-fill.** The press reads the note's own
unread files first (its pictures, and a scan whose text layer turned out empty, whether
the server's conversion found nothing or the browser's did), up to five at a press, with
the rest reported as still waiting, and then suggests from what they say. That is the one
place the instance calls the model to read a file, and the press is the person asking for
it. Never for a PDF that has a text layer: the free reader goes first, and the paid one only
gets what it leaves. The bytes go to Anthropic, which does not train on them and deletes them
within thirty days under its terms for businesses; each file is read
once, and a decline is recorded so it is not asked again.

A picture nobody presses Auto-fill for stays unsearchable, and that is the trade, made in
MAK-178. Until then every picture was read as it arrived (from the editor, the phone, an
import or an assistant) and a bulk pass on the Maintenance page read the backlog: on a
real archive thousands of paid requests nobody asked for, and every one of them a photo
leaving the instance that its owner never chose to send. Cost that grows with uploads cannot
be covered by a flat price, and a press is consent where an upload is not.

**An assistant can read a picture itself.** Over MCP, `get_attachment` returns a picture as
an image for the assistant's own model, and `set_attachment_text` records what it read,
marked `assistant` beside the layer's and the model's text. Those words are a hint for
search and the summaries, not the document: the next Auto-fill press on the note has the
instance's model read the file and replaces them, and an assistant may never write over a
text layer or the model's reading. The instance calls no model for any of it, and the
bytes go to the assistant the person connected, nowhere else.

**Which model.** The model has three jobs inside a press: reading the files, writing the
title, writing the text field values (see [Filing a note from what it
says](#filing-a-note-from-what-it-says)), and each has a variable: `ANTHROPIC_READ_MODEL`,
`ANTHROPIC_TITLE_MODEL` and `ANTHROPIC_FIELDS_MODEL`, each falling back to `ANTHROPIC_MODEL`
and then to `claude-haiku-5-5`. The reading is the one whose cost grows with what you keep,
so it was measured on forty-five hard files from a real archive (faded receipts, business
cards, handwritten forms, scans with no text layer, a twenty-two-page lease) against an
answer key of 261 facts. Haiku 5.5 read 240 of 243 right; Sonnet 5.5 read every one of its
236 and Opus 5.5 all but one. Every model read every phone number, email, merchant and
total; the difference was one handwritten form, a word and a date. A read cost about 0.1¢ on Haiku, 1.6¢ on Sonnet and
3.3¢ on Opus, and Haiku was the fastest. So Haiku is the default for every job, and the
dearer models buy handwriting and nothing else measurable. If your archive is handwriting,
set `ANTHROPIC_READ_MODEL=claude-sonnet-5-5` and leave the title and the fields on Haiku:
those only copy words off a reading already made, and gained nothing from a bigger model.

`ANTHROPIC_READ_EFFORT` is how hard the reading model thinks, `low` to `max`. Unset, the
default model reads at `low`, which on the same sample tied `medium` and `high` on what it
read and was the fastest and cheapest: thinking harder does not change what is on the page.
A model you name gets no effort unless you set one, and beside a Sonnet read you should set
`low`: at its default effort its thinking alone fills the output budget on a long scan, and
the read never finishes. The whole of it sits behind one interface in
`apps/api/src/lib/llm.ts`, so another model, or Workers AI for an instance that would rather
keep images in place, is one more implementation of it.

## Filing a note from what it says

A scan arrives as an untitled note in the Inbox holding one PDF, and filing it (a title, a
notebook, tags, the amount and the date copied into the notebook's fields) is the same
minute of work for every one of thirteen thousand. **Auto-fill**, in a note's head, does that
minute: it reads what the note and its files say and fills in whatever is empty, and asks
before replacing anything already set. What it fills lands in the editor's draft like a
typed value, so it saves when the note saves and is undone by retyping.

It is on when the instance has a key for [Jev](https://docs.typesafe.ai), TypeSafe's model
for exactly this shape of question, and drawn nowhere otherwise:

```bash
cd apps/api
pnpm exec wrangler secret put TYPESAFE_API_KEY
```

Locally, the same name in `apps/api/.dev.vars`. A key of its own for development keeps its
usage apart from production's.

**What is sent, on each press.** The note's title and body, the text already extracted from
its PDFs (see [Searching inside PDFs](#searching-inside-pdfs): a scan that has not been read
yet is reported as such rather than guessed at, and a photograph's text is what the press
itself reads first, where the instance [reads images](#reading-images)), and
the names of your notebooks, tags and fields, with a few recent titles from each notebook and
tag as examples of what belongs there. Nothing else in the archive. Nothing is sent until the
button is pressed. TypeSafe does not train on what it is sent, and keeps it under its own
privacy policy, which names no fixed period.

The built-in privacy policy says all of this where the instance has the keys for it, and
names Anthropic only where there is a key for it too (`autofill` and `llm` in
`/api/config`). An operator who publishes their own documents has to say it themselves.

**The first press asks.** The button says "Auto-fill" with a sparkle, which is the
convention and not the fact, and nobody reads a privacy policy before pressing a button,
so the first press on a device sends nothing: it asks, in the place the replace question
appears, whether to send the note to an AI model, says what goes and to whom (naming
Anthropic only where the instance reads images), links the privacy policy, and runs the
press from its Fill in. Cancelling sends nothing and asks again next time. The
acknowledgement is kept on the device, per account, so a new browser is told once more;
it is not a setting on the account. The tip on the button names the model every time.

**Why Jev.** It chooses rather than writes: the notebook, the tags and every select or
checkbox are choices among things that already exist, so it cannot invent a notebook or
misspell a tag, and each answer comes with a confidence. For free-form fields the code finds the
candidates (every date the text writes for a date field, every amount for a number, the
document's own lines for a text field) and the model picks one or says none of them. The
title is written rather than chosen: where the instance has a language model, the same key
that [reads images](#reading-images), it is asked for the title a careful person would give
the note, and Jev's pick of the document's own lines stands where there is none. The same
model writes a text field's value, so a Vendor gets "Acme Rentals" rather than the whole
"Thank you for shopping at Acme Rentals Store #4471" line, and a value it writes is kept
only when the document contains it. Without one, a line written as a label and a value,
like "Order number: 112-0042", offers the value alone too. A value can still be wrong, but
it is always something the document actually says, and anything the model is unsure of is
left empty rather than guessed. Ratings are left alone: a document has no opinion to read.
How Jev compares with SubQ Snap, the other decision model, and with one language-model
call doing all of it, is measured in [Auto-fill's decision model, measured](autofill-benchmark.md),
with the harness to run it on your own archive.

**What it costs, and the ceiling.** Every press is counted per account, and so is every
token the language model is paid for inside one: by day, by job (reading a file, the
title, the fields) and by model, since a token's price is the model's. Maintenance shows
the account's presses and tokens for the year. A press is one request anyone signed in can
send in a loop, so `AUTOFILL_DAILY_CAP` sets how many one account may make in a UTC day;
past it, the button says how long until it works again. Unset, nothing is refused.
`AUTOFILL_YEARLY_CENTS` bounds the year the same way, in cents of what the model's tokens
cost at the prices kept in `packages/shared/src/llm-prices.ts`; past it the button says
this year's Auto-fill has been used, and never names money. An instance that sells
the plan can give an account on its trial smaller numbers with `AUTOFILL_TRIAL_DAILY_CAP`
and `AUTOFILL_TRIAL_YEARLY_CENTS`, which an account on the free plan gets too, beside a
lifetime pool of its own (`AUTOFILL_FREE_PRESSES`); [Selling the plan](billing.md#selling-the-plan)
says why.

`POST /api/notes/:id/autofill` answers with the suggestions and applies nothing; the client
does. The Android app is the site in a WebView, so it has the same control.
