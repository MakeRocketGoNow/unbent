# History and trash

## Undoing an edit

The trash covers a note that was deleted. A note that was changed for the worse (a paste
over the wrong selection, an assistant's `edit_note` that replaced more than it was meant
to, a batch that refiled the wrong forty notes) is covered by its history: **History** in
a note's ⋯ menu lists earlier versions, shows any of them as the note would read, shows
what restoring it would change, and puts one back.

A version is the note's title and body, and its notebook, tags and field values. In a
notebook that is mostly fields (a watch list, a log, a set of business cards), the fields
are the note, and changing only those keeps a version like any other edit.

A version is kept when a write changes the note, and how often depends on who is writing:

- **Your own edits** keep one version per half hour: the note as it was before the sitting
  began. The editor saves about once a second while you type, and a version per save would
  be a copy of the whole note per pause. A run of field changes is one version, not ten;
  so is tagging or moving a selection of notes from the list.
- **An assistant's write** over MCP keeps what it replaces even inside that half hour,
  whether it rewrites the text, sets a field or refiles a batch. The usual assistant edit
  arrives minutes after you stopped typing, and what it replaces is exactly what is worth
  having back. A run of edits by an assistant leaves one version, the note before the run,
  so a long job cannot push your own text out of the history.
- **A restore** keeps what it replaces, always. Restoring is undone the same way it was
  done, and the message that follows one has an Undo.

Restoring puts the fields, tags and notebook back with the text, as far as they still fit.
A notebook, tag or field deleted since stays deleted, and a value its field can no longer
hold (the field was converted, or lost that choice) stays as the note has it. The
Changes view says so beforehand and the message after the restore names what was left;
the rest of the version is restored either way. What a notebook's or a tag's own settings
do to every note under them (a rename, a field converted) is not a note's history, and a
restore does not undo it.

The newest fifty versions of a note are kept, and none for longer than a year. It is
a safety net for a recent mistake rather than an archive: versions are not in an export
and are not copied to your devices, so the sheet needs a connection. They do not hold
files, so a version shows its pictures and files as they are now, and a file deleted since
stays deleted. Versions kept before fields, tags and the notebook were part of one hold
text only; restoring one of those leaves the rest of the note as it is.

It also means that text you delete from a note is not gone at once. A password pasted into
a note and then removed is still in that note's History, for anyone signed in to the
account, until the version ages out. **Clear history**, at the foot of the sheet, deletes
every version of that note for good and leaves the note as it is; it asks first, since it
is the one thing in the sheet that cannot be undone. What it cannot reach is the thirty
days of point-in-time recovery every store keeps (see [Where your notes
live](#where-your-notes-live)): an operator winding the whole account back to before the
clear would bring the versions back with everything else; nor the daily dumps, which hold
the store whole and age out within about three months (see [Durability](#durability)).
Emptying
the trash takes a note's history with it, and deleting the account takes all of it.

The API is `GET /api/notes/:id/revisions`, `GET /api/notes/:id/revisions/:revision`,
`POST /api/notes/:id/revisions/:revision/restore` and `DELETE /api/notes/:id/revisions`.
There is no MCP tool for it yet: an assistant can cause a version to be kept, but only a
person can put one back.

## Deleting notes

Note deletion in the app is a soft delete: the note goes to trash and its attachments stay
in R2 so a restore is not left with dead links. To reclaim that storage, Settings has a
Maintenance page:

- **Empty trash**: permanently deletes soft-deleted notes and their files.
- **Sweep orphaned files**: removes R2 objects with no attachment row. Files you
  unlinked from a note still have a row; delete those from the note’s Attachments list.
- **Delete all notes**: wipes every note and attachment in the account. Requires typing
  `DELETE`, since nothing in your own hands reverses it: an export is the only way back
  you hold, and an operator's wind-back or dump load (see [Durability](#durability)) is
  theirs to offer, not a control of yours.

The API equivalents are `POST /api/admin/purge-notes?scope=trashed|all&confirm=DELETE` and
`POST /api/admin/gc-blobs?apply=1`. Both are scoped to the caller's own data.

**Deleted files follow the store for thirty-five days.** Emptying the trash, deleting a
single note from it and deleting a file from a note remove the rows at once, but not the
objects: the store writes each file's key to a table of deleted files (`deleted_blobs`,
schema 0005) in the transaction that removes the row, and the hourly sweep deletes from R2
only what has sat there for thirty-five days, then has the store forget it. Nothing a
person can do brings a purged note back: this is for the operator. A store keeps thirty
days of history, and [winding one back](#where-your-notes-live) winds the table of deleted
files back with the rows, so a restored note finds its files still in the bucket; the five
days on top are so a restore to the far end of the window still finds them. The account's
own file sweep counts a file awaiting deletion as referenced for the same reason, and
reports it as `awaitingDeletion`. Deleting an account is the exception: its files go at
once, as they always did, because the account's deletion is what its owner asked for.

For local development, `pnpm --filter @unbent/api reset:local` clears D1, R2 and the note
stores entirely and rebuilds the schema, backing up D1 and the stores first. Use that rather
than the in-app sweep to clear fixtures left by deleted test users: the scoped sweep cannot
reach another account's prefix by design.
