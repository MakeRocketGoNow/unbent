# Editing

**The goal is WYSIWYG.** Bold looks bold, headings are sized, task lists get real
checkboxes, attachment images render inline, and tables are edited with buttons rather
than by hand. Markdown is the storage format, not the interface: nobody should have to
count pipe characters to add a column.

What we will not do is get there the usual way.

## Why not a document model

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

WYSIWYG *behavior* is entirely compatible with that. WYSIWYG *architecture*, a parallel
document model that owns the truth, is not.

## How it works instead

CodeMirror 6 edits the Markdown directly, with a rich mode that styles the source in
place. Syntax characters hide unless the cursor is inside the node they belong to, so
reading stays clean and editing stays direct. The text never leaves the buffer, so there
is no parse-and-reserialize step in which it could be rewritten.

Every affordance is built on top of that rather than around it:

- A toolbar and the usual shortcuts (⌘B, ⌘I, ⌘K, ⌘⌥1) apply formatting as text edits.
- Tab and Shift-Tab indent and outdent list items; outside a list Tab moves focus as
  usual, so the editor is never a keyboard trap.
- Tables get a toolbar anchored to the table the cursor is in: insert and delete rows and
  columns, set column alignment, and a grid size picker for creating one. Restructuring a
  Markdown table by hand means editing every row plus the delimiter, so the tedious
  operations get buttons; each one is still a plain edit through
  `apps/web/src/editor/markdown-commands.ts`, which rewrites the table's text and lets
  CodeMirror's history record it as a single undo step.
- Dragging a file in shows a drop cursor at the exact insertion point.
- An Attach button in the toolbar opens the file picker, for a phone and for anyone who
  would rather not drag. It goes through the same routine as a drop or a paste: a
  placeholder at the cursor, replaced by the link when the upload lands, one undo step.

The test for any new editing feature is the same one every time: **can it be expressed as
an edit to the text, undone with a single ⌘Z, and retyped by hand to the same result?** If
yes, it belongs, however rich it looks. If it needs a parallel document model, it does
not, however convenient that would be.

Rendering uses GFM (tables, task lists, strikethrough, autolinks) plus soft line breaks:
a single newline is a line break, not a space. CommonMark folds lone newlines into spaces,
which turns a note written as separate lines into one run-on paragraph: pressing Enter in
a notes app should start a new line. Soft breaks are not part of GFM itself; they are a
separate remark plugin.

## Still to build

Toward the same goal, under the same constraint: inline image resizing, a link editor that
does not require selecting the whole `[]()`, and drag-to-reorder for list items.
