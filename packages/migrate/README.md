# @unbent/migrate

`unbent-migrate` — import Evernote `.enex` files into Unbent from the command line.

The in-app importer handles a single file well. This is for the case a browser is bad at:
a whole account's worth of exports, run unattended, resumed after an interruption, without
dragging dozens of multi-gigabyte files through a file picker.

```bash
unbent-migrate login --url https://notes.example
unbent-migrate import ~/evernote/*.enex --url https://notes.example
```

`--url` defaults to `$UNBENT_URL`, then `http://localhost:5173`.

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
| `--notebook <name>` | File notes under this notebook instead of the filename |
| `--no-text` | Skip PDF text extraction — faster, but scans stay title-only |

By default the filename becomes each note's notebook, so `Recipes.enex` lands in a notebook
called `Recipes`.

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
