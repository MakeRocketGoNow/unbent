# @unbent/migrate

`unbent-migrate` — import Evernote `.enex` files, or Unbent's own exports, into Unbent from
the command line.

The in-app importer handles a single file well. This is for the case a browser is bad at:
a whole account's worth of exports, run unattended, resumed after an interruption, without
dragging dozens of multi-gigabyte files through a file picker — or a backup restored from
a shell.

```bash
unbent-migrate login
unbent-migrate import ~/evernote/*.enex
unbent-migrate import ~/backups/unbent-export-2026-09-15.zip
```

An Unbent export — the library zip, a notebook's, or a single note's zip or `.md` — arrives
with each note's own notebook, tags, dates, fields, files and id, exactly as Settings →
Import takes it in the browser. Nothing is read into memory whole: the zip is opened as a
lazily read `Blob` and each entry pulled by byte range.

The first command asks which instance to use and remembers the answer, so nothing after it
needs a URL. There is deliberately no default: a guessed instance means a forgotten flag can
send a migration to a server you did not choose, and that failure is silent, because
uploading to the wrong Unbent still succeeds.

Change it later with `unbent-migrate set-url https://unbent.app`, or by editing the file
`unbent-migrate show-config` prints — it is plain JSON, mode 0644, and separate from
`credentials.json` so that changing a URL never means opening a file with a token in it.
`--url` overrides it for a single command, and `$UNBENT_URL` for a shell session.

## Signing in

`login` prints a short code and a link. Approving it in a browser you are already signed in
to grants the CLI an ordinary session — no password is typed into the terminal and no
long-lived key is pasted from a settings page. The token is stored in
`$XDG_CONFIG_HOME/unbent/credentials.json` (mode `0600`), keyed by instance so a token for
one server is never sent to another.

`logout` forgets the token locally; `logout --all` forgets every instance. Neither revokes
the session — do that from the app, where signing out everywhere covers the CLI too.

## Resuming

Imports are idempotent per note: the server keys on a hash of title and body, so re-running
the same file skips what already landed and retries only what did not. An interrupted run —
a closed laptop, a dropped connection, a failed batch — needs no special handling. Run the
same command again.

## Options

| Flag | Meaning |
| --- | --- |
| `--url <url>` | Which Unbent instance to import into |
| `--notebook <name>` | File every note under this notebook instead |
| `--no-text` | Skip PDF text extraction — faster, but scans stay title-only |

By default an `.enex` file's name becomes its notes' notebook, so `Recipes.enex` lands in a
notebook called `Recipes`; an Unbent export's notes each name their own.

## Getting the .enex files

Evernote has no export API, so the files have to be produced first: File → Export notes in
the desktop client, or [evernote-backup](https://github.com/vzhd1701/evernote-backup) for a
whole account, which writes one `.enex` per notebook.

## Layout

```
src/auth.ts         device flow (RFC 8628) — code request and polling
src/client.ts       ImportClient over a bearer token
src/token-store.ts  where the session is kept, and how tightly
src/cli.ts          argument parsing, progress, failure reporting
```

Everything above the transport — ENML to Markdown, attachments, hashing, progress — comes
from `@unbent/enex`, the same code the browser importer runs.
