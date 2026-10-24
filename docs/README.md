# Unbent documentation

The [front page](../README.md) says what Unbent is. These pages are the rest, moved out
of it unchanged: each is a design record as much as a manual, with the decision and the
alternative that was rejected, which is the house style ([AGENTS.md](../AGENTS.md)).

- [Development](development.md): setting up a checkout, and working from a worktree.
- [Self-hosting](self-hosting.md): Running your own instance (the button, GitHub Actions,
  from your laptop, your own domain, everything you can set, who runs this instance, page
  statistics, errors in the browser, the dev instance, preview deployments, choosing
  sign-in methods) and Auth.
- [The editor](editor.md): Editing, and why it has no document model.
- [Search and Auto-fill](search.md): Search, Searching inside PDFs (and reading images),
  and Filing a note from what it says.
- [Auto-fill's decision model, measured](autofill-benchmark.md): Jev against SubQ Snap and
  against one language-model call, on 46 notes, with the harness to run it yourself.
- [Sync and offline](sync-and-offline.md): Your library on the device, and the Local
  database.
- [History and trash](history-and-trash.md): Undoing an edit, and Deleting notes.
- [Billing and account deletion](billing.md): Selling the plan, and Deleting an account.
- [Android app](android.md): the shell, captures, and building it for your own instance.
- [iOS app](ios.md): the shell, captures, and building it for your own instance.
- [Architecture](architecture.md): the Stack, Where your notes live, Tenant isolation,
  Durability, and Blob garbage collection.
- [Backups and export](backups.md): the export, Restoring or moving to another Unbent,
  Importing from Notion, and Importing from Joplin.
- [Known gaps](known-gaps.md): what is advertised and not yet enforced.
