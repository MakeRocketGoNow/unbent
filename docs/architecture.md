# Architecture

## Stack

- **Cloudflare Workers** + Hono: API, and static-asset hosting for the SPA
- **TanStack Router + Query**: real routes, typed search params, cached loaders
- **Cloudflare Durable Objects** (SQLite): one per account, holding its notes, metadata
  and FTS5 full-text search; see [Where your notes live](#where-your-notes-live)
- **Cloudflare D1** (SQLite): accounts, sessions, OAuth clients, and the account directory
- **Cloudflare R2**: attachment blobs
- **Better Auth**: OAuth (Google, GitHub)
- **Vite + React + CodeMirror 6**: Markdown editor, styled in place (see [Editing](editor.md#editing))

One Worker serves both the built SPA and `/api`, so the two are genuinely same-origin and
the session cookie needs no CORS or `SameSite` workarounds.

The free tier is enough, including for the initial migration. Measured against a real
13,158-note Evernote account with 4,084 attachments:

| Limit | Full import | Free tier |
| --- | --- | --- |
| Worker requests | ~17,200 | 100,000/day |
| D1 rows written | ~43,400 | 100,000/day |
| R2 storage | 2.6 GB | 10 GB |

Import posts one note per request, plus one per attachment. That is deliberate rather than
unoptimized: per-note requests are what let an interrupted import resume without any
server-side progress tracking, and a re-run costs one request and *zero* D1 writes per note
that already landed, because the content-hash lookup short-circuits before any insert.

The tightest of these is D1 rows written per day, at roughly 2.3x headroom, so the thing
to avoid is importing a whole account twice in the same day. Nothing here needs Workers
Paid; take it for the higher ceilings if the instance grows, not to get started.

CPU is not a constraint at either end: ENEX parsing runs in a browser Web Worker rather
than on Workers, and the export zip is assembled in the browser from pages of notes.

## Where your notes live

Each account's notes are in a database of their own: a SQLite-backed Durable Object per
user, `UserStore` in `apps/api/src/store/`, holding that account's notes, tags, notebooks,
fields, attachment rows and search indexes and nothing else. D1 keeps what is shared across
accounts (sign-in, connected apps, upload links, and a directory of accounts) and R2
keeps the files. The reasons are in the decision record on the issue that started this; the
short one is that the app's partition is absolute (no sharing, no cross-account read
anywhere), and when the natural partition is the user and each partition is tens of
megabytes, one SQLite per user is the shape the primitive was built for. Requests get
faster, since every statement after the first call runs in-process; restore becomes per
account rather than per instance; and the multi-device sync that is planned next wants
exactly one writer per user.

The Worker authenticates and forwards. `requireAuth` runs there; `reposFor` binds the
request to the session's own object, and every route, MCP tool, export page and import then
reads and writes through it. Five rules hold the shape, and tests hold the rules:

1. **The object touches its SQLite and nothing else.** No outbound call inside it: R2 bytes,
   the language model, the auto-fill API and mail all happen in the Worker before or after
   the call. Blob *keys* go through the object, which owns the attachment rows; bytes never
   do.
2. **Ids stay globally unique UUIDs** even inside a per-user database, so `(owner, id)` is
   unambiguous forever and an archive imported into two accounts keeps its ids in both.
3. **The owner's object is the source of truth.** If sharing ever comes, a grantee reads
   and writes through the owner's object.
4. **The change feed is per user, with a sequence cursor.** Never a global one.
5. **Each call to the object is a billable request.** A route asks once for what it needs,
   through composite methods, rather than two or three times.

**The cutover** (September 2026) copied every account's rows out of the shared D1 tables
into its store, verified each table's count against what D1 held, and then dropped the
tables: migration 0036, guarded so it refuses to run while any account with rows is not
recorded as copied. The directory's `migrated_at` and `copied_at` are its record: when
each account's rows were frozen against writes during the deploy, and when they were
verified copied. The copy, the freeze that protected the rows, and the operator's route for
it are in the history of MakeRocketGoNow/unbent#202; nothing in the code reads D1 for notes
any more, and there is no way back to the shared tables. Restoring an account is per
account: to a moment in the last thirty days, or from its dump (below).

**Schema changes** are files in `apps/api/src/store/schema/`, applied per object on its next
wake, additive only. The sweep is what makes that safe to rely on: it wakes every object
(twenty an hour, from a cursor it keeps in D1, since every store call counts against an
invocation's fifty subrequests on Free) so a migration that fails for one account fails in
the log with the user id on it. Each visit reads a few rows of the account (its size and
the stored note counts), never a table. The deploy runs a whole pass as its last step, when
the repository has a `SWEEP_TOKEN` secret: `scripts/sweep-stores.mjs` sends the token in
place of a session, starts the walk from the top rather than from the cron's cursor, calls
the sweep until it is done, and fails the deploy if any account's
store did not wake. Without the secret the step skips and the cron gets there within the
day.

**Daily dumps.** Where a backups bucket is bound as `BACKUPS`, the same cron at :47 dumps
every account whose store has changed into it, as `stores/<user>/<YYYY-MM-DD>.sql`: the
file `GET …/dump` below writes. An account is tried once a day; it is dumped when its change
feed has moved since its last dump, and in any case once that dump is a week old, so a
bucket whose lifecycle rule deletes dumps after fourteen days always holds one of every
account. A big store is read in several calls, so a write can land partway; such a dump
says so in its last lines, and the account is dumped again the next day. The account directory records each one's last dump, and every run writes
`status/dumps.json` to the bucket: what it did, and which accounts failed or have gone
forty-eight hours without a dump found current. Nothing is bound at the top level of
`wrangler.toml`, so a fork's instance never dumps; unbent.app's production deploy binds the
bucket its `BACKUPS_BUCKET` repository variable names, and the dev instance binds
`unbent-dev-backups`. A run keeps to fifty subrequests, the Free plan's, which caps a dump
near 170 MB of SQL; an account past that is recorded as failed rather than dumped, and
is tried again each day after every other account, which spends that run's budget. On
Workers Free a large account may not finish a scheduled dump well before that, since a
run's CPU time is limited too. A self-hoster arranges their own backups.

**Nightly mirror.** unbent.app keeps a copy of all of it in a second Cloudflare account,
pulled from outside by `.github/workflows/mirror.yml` each night at 05:23 UTC with
`rclone`: the live files bucket to `blobs/`, the dumps bucket's `stores/` to `stores/`, and
a `wrangler d1 export` to `d1/<date>.sql`. Those three prefixes are under a thirty-day
retention lock in that account, so nothing can overwrite or delete a copy younger than
that, and lifecycle rules delete dumps and D1 exports after ninety days. Files are pruned
by the workflow instead: a key in the mirror and not in live is gone, the date it was
first seen gone is written to `state/prune.json`, and its copy is deleted once it has been
gone fifty-five days (`scripts/mirror/prune-plan.mjs`, a pure function with a test; a
live listing that comes back empty fails the run rather than planning against it). The
run then reads the Worker's `status/dumps.json` and fails if a dump failed, an account has
no dump found current in forty-eight hours, or the status is older than that, so the
Worker's half of the backup fails loudly too; and it writes `status/mirror.json` back to
the dumps bucket (when it ran, what it copied and pruned, the export's size) for the
operator's page. It runs only where the repository has the nine secrets in the
[configuration table](self-hosting.md#everything-you-can-set) and the `BACKUPS_BUCKET` variable, read-only on the
live bucket, and skips itself otherwise; a fork names its live and mirror buckets at the top
of the file. The first copy, and any rerun, is
started by hand from the Actions tab.

**Putting files back.** `.github/workflows/restore-files.yml` copies one account's files
from the mirror back into the live bucket: started by hand only, from the Actions tab,
with the account id and the word `RESTORE` typed in; anything else in that box is a dry
run that lists the counts and copies nothing. It is the one workflow that can write to
the live bucket, with a credential of its own (`RESTORE_R2_ACCESS_KEY_ID` and
`RESTORE_R2_SECRET_ACCESS_KEY`, in the `restore` GitHub environment, which only a
workflow on `main` may use: that rule on the environment is what keeps an edited copy
of the file on a branch away from a key that can delete from the live bucket).
`rclone copy --ignore-existing` is the whole of what it does: nothing
is deleted and nothing already in the live bucket is overwritten, so running it twice is
the same as once, and it never writes to the mirror, so the prune's state file is left
alone: the files reappearing in live are enough for the next night's prune to forget
their gone-dates. The run's summary has counts; the files' names stay out of it.

**Losing the whole Cloudflare account.** Everything above is in one account but the
mirror, and this is how the mirror is turned back into an instance. Expected loss: up to
a day of notes, since the newest dump is from the last 00:47 UTC and the mirror copied
it at 05:23; files uploaded since that night's copy; and every store's thirty days of
history, with its undo bookmarks. Files deleted in the fifty-five days before are still
in the mirror and come back as orphans the file sweep reclaims.

1. A new Cloudflare account, with the same names: the Worker, a D1 database, and the
   buckets `wrangler.toml` and the mirror workflow name (`unbent-blobs`,
   `unbent-backups`). Point the domain at it.
2. Create the database and import the newest `d1/<date>.sql` from the mirror, after
   putting its schema first: `node scripts/mirror/order-d1-export.mjs d1.sql ordered.sql`,
   then `wrangler d1 execute <name> --remote --file ordered.sql`. The export as written
   puts every index after all the rows, and a fresh database refuses the first row whose
   foreign key points at a column one of those indexes makes unique: a "foreign key
   mismatch" that D1's import reports only as `{"D1_RESET_DO":true}`, with nothing
   imported. The script exits non-zero if the export holds a statement it does not
   know; read what it says before importing. Then deploy: every migration is recorded
   in the export, so the deploy's migration step applies nothing, and the
   Worker's secrets come from the password manager, which is the one place they are
   kept: `BETTER_AUTH_SECRET` above all, or every session is lost with it and everyone
   signs in again. If that secret is gone too, deploy with a new one and then
   `wrangler d1 execute <name> --remote --command "DELETE FROM jwks"`: the export
   carries Better Auth's signing key encrypted with the old secret, and until the row is
   gone every session read is a 500 (`Failed to decrypt private key` in the Worker's
   log) behind a sign-in form that never goes away. Better Auth makes a new key on the
   next request. The sessions were lost with the secret either way; passkeys survive,
   since a passkey is a public key in the database and the secret only signs the
   challenge it answers.
3. Copy the files back: `rclone copy mirror:unbent-mirror/blobs/ live:unbent-blobs/`
   from a laptop with the mirror's credential and a write key for the new bucket, or
   the restore-files workflow once per account.
4. Copy the dumps back to where the load route reads:
   `rclone copy mirror:unbent-mirror/stores/ dumps:unbent-backups/stores/`.
5. For each account in the directory (`SELECT user_id FROM account_directory WHERE
   deleted_at IS NULL`), `POST …/load` with the newest dump under `stores/<id>/`. The
   object is empty on a new account, so there is nothing to dump first and nothing to
   undo to; the load's own dump of it is a few kilobytes.
6. New R2 tokens and GitHub secrets for the mirror and the restore workflow, since the
   old account's are gone with it, and a hand-started run of the mirror to prove the
   new account is being copied.

**The change feed.** Every write records what it touched, numbered by the store's own
counter, and `GET /api/changes?since=N` answers "what changed since N?" with the changed
notes whole (body, tags, values, files), the changed notebooks and tags, and a tombstone
for anything purged. A device with no copy yet walks the whole library through
`GET /api/changes/snapshot`, then follows the feed from the counter the first page
reported. `GET /api/changes/socket` is the push: a WebSocket the store tells the counter
on after every write, held through the platform's hibernation so an idle device costs
nothing; the feed is complete without it. The feed keeps ninety days or fifty thousand
rows; a cursor older than that, or from before a restore, is answered with `reset` and
the device starts over from a snapshot. This is what the local copy of the library in the
browser syncs from; see [Your library on the device](sync-and-offline.md#your-library-on-the-device).

**What the operator can see.** An object has no console, so the Worker has one, under
`/api/admin/store` for a session in `OPERATOR_EMAILS`:

- `GET …/stats`: row counts, size and schema version, the caller's own or `?user=`'s. A
  name the directory does not have is refused, since a store is created for any name it
  is asked for.
- `POST …/sql`: one `SELECT` (or `EXPLAIN`) against a store, always rolled back.
- `GET …/dump`: the store as SQL text, `sqlite3 account.db < dump.sql` rebuilds it: what
  `d1 export` was, and how a migration is rehearsed against a real account before it
  ships (dump, load, run the new schema file's SQL against the copy). The daily dumps
  (above) are the same file.
- `POST …/restore`: winds one store back to a moment in the last thirty days; see below.
- `POST …/load`: replaces one store with a dump from the backups bucket; see below.
- `POST …/feed-epoch`: makes every device of an account resync its local copy, by
  naming a new history for its change feed. The restore does this itself.
- `POST …/sweep`: one batch of the walk, now; `?restart=1` on the first call starts from
  the top of the directory, then call without it until it says `done`. Also open to the
  deploy, with the deployment's `SWEEP_TOKEN` in an `X-Unbent-Sweep-Token` header instead of
  a session.

Reading another account's store is logged with both ids. Rows read and written inside an
object are metered as D1's were, and every statement over a threshold is logged with the
user id, which is the accounting `wrangler d1 insights` used to give.

**Winding a store back.** Every store keeps thirty days of history, and `POST …/restore`
puts one back as it was at a moment in them: the rollback for a schema file that broke an
account, or an edit that should not have happened. It is for one account at a time and
the operator only; moving notes between accounts or instances is export and import. A
deleted account is refused: its wipe is part of the history, and winding back past it
would bring back notes its owner asked to have removed.

1. `GET …/dump?user=<id>` and keep the file. It is the copy that outlives the thirty days.
2. `POST …/restore` with `{ "user": "<id>", "at": "2026-09-30T12:00:00Z" }`. Without
   `confirm` this is a dry run: it says which bookmark the time resolves to, refuses one
   outside the window, and shows the store as it is now.
3. Repeat with `"confirm": "RESTORE"`. The store restarts to apply it, and the answer has
   the restored store's counts and an `undo` bookmark: the store as it was the instant
   before. `{ "user": "<id>", "bookmark": "<undo>", "confirm": "RESTORE" }` reverses it.
   Every restore and load is also kept in D1 (the `restores` table) with the operator who
   asked, and the operator page lists them under the wind-back form. It offers Undo on the
   newest only: an older one's bookmark is from before everything after it. The Worker's
   log has each bookmark as well.

The whole database goes back together, schema version included, so a restore to before a
schema file is migrated again on the next wake. Files are in R2, not the store, and are
not wound back, but they follow it: a file deleted since the restored moment is still in
the bucket, because a deleted file's object stays for thirty-five days under a tombstone
the store keeps (see [Deleting notes](history-and-trash.md#deleting-notes)), and the restore winds that
tombstone back with the row, so the file is simply the note's again. The five days past the
thirty of history are the margin for a restore to the oldest moment it can reach. One
uploaded since the restored moment is an orphan, which the account's own
[file sweep](billing.md#deleting-an-account) reclaims. Local development has no
history to restore from (Miniflare refuses, and the route answers 501) so a restore is
tried on a preview of a PR that touches `src/store/`, which has stores of its own.

**Loading a dump.** A fault noticed after the thirty days, or a store that is simply
gone, is put back from a dump: `POST …/load` with `{ "user": "<id>", "dump": "2026-10-06" }`
names that day's daily dump in the backups bucket, and `"dump": "stores/<id>/<file>.sql"`
names any other file under the account's own prefix: the one written before an earlier
load, or one copied back by hand from the mirror. A dump can only be loaded into the
account it was taken from. Without `confirm` it is a dry run: whose the file is, when it
was taken, whether its rows are one moment of the store or were read while it was being
written to (the file's last lines say), and the store as it is now. With
`"confirm": "LOAD"`:

1. The store as it stands is dumped first, to `stores/<id>/<time>-before-load.sql` beside
   the daily dumps, where the nightly mirror copies it off-account; the answer names it
   as `before`.
2. The object takes a bookmark of itself (`undo` in the answer; the restore route winds
   back to it in one call for thirty days), empties itself, and marks itself loading.
   From that moment until the load is whole the store refuses every request with a 503
   and `Retry-After`, the same answer any passing unavailability gets, so a half-loaded
   store is never read as an empty one. The mark is in storage, so it holds across an
   eviction.
3. The file is streamed into the object in pages, each run in one transaction with
   foreign keys off, as `sqlite3` would load it; a row too long to run as one statement
   (a long body, a file's text) runs with its values bound.
4. The object checks that the dump's `_meta.user_id` is its own and that its schema
   files are ones this code knows, applies any the dump lacked (a dump from before a
   schema file loads at the current version, not the dump's), names a new feed epoch so
   every device starts over from a snapshot, and only then clears the mark.

A failure after step 2 leaves the store refusing, and the answer says so with both ways
out: restore to `undo`, or load `before`; calling again starts over. Files are not in
the dump and are not touched: a file the dump's rows name is still in the bucket if it
was deleted less than thirty-five days before, since the dump carries the store's
tombstones for it; one deleted longer ago is gone from the live bucket, and comes back
from the mirror (below). A file uploaded after the dump was taken is an orphan the
account's own [file sweep](billing.md#deleting-an-account) reclaims. The answer counts rows whose
parent the dump does not hold, which a dump read mid-write can have.

**Where an object lives.** The platform creates each account's object near the first
request for it, and objects do not move. `STORE_JURISDICTION=eu` keeps every store in the
EU, for an operator whose users need that. It is decided once, before the instance's first
account, and never changed: the jurisdiction is part of how a store is found, so the same
account names a different, empty object with it set than without, and changing it on a
running instance would make every account's notes vanish from view.

**Deleting an account** wipes its object; see [Deleting an account](billing.md#deleting-an-account).
Locally, the objects are files under `.wrangler/state/v3/do/`, which `sqlite3` opens, and
the reset scripts clear them with the database they belong to.

What does not change: notes are Markdown with frontmatter, export is the same folder tree,
and a restore is an import.

## Tenant isolation

Notes are isolated by construction: each account's are in a database of their own, and no
query can name another account's rows because no such rows exist where the query runs.
`reposFor` in `apps/api/src/lib/repos.ts` binds a request to the session's own object, and
the object refuses on every wake a database whose stored owner is not the user it was
created for. Route handlers never reach for a store or for `env.DB` themselves; a static
test in `apps/api/src/store/guards.test.ts` holds that line.

What stays in D1 (sessions, OAuth clients, upload links, the account directory) has no
row-level security, so for those tables isolation is still application code: the scoped
repos in `apps/api/src/lib/repo.ts` take the user id as a constructor argument, and an
unscoped query is not expressible from a route. `apps/api/test/isolation.test.ts` asserts
all of this from outside and grows with every phase that adds a route touching user data.
The MCP endpoint's cases live beside it in `apps/api/test/mcp.test.ts`, which needs a whole
OAuth flow before it can call anything and would otherwise swamp the suite it belongs to.

One route finds its user another way. `PUT /api/uploads/:token`, the other half of
`prepare_attachment_upload`, is authorized by the token in its path and nothing else. The
token is looked up once, deleted as it is read, and yields the user id the scoped repos are
then built from, exactly as a session does everywhere else. Its cases are in `mcp.test.ts`
too, since only the tool can mint one.

## Durability

What unbent.app promises about keeping your notes, stated as what is true on `main` today
and nothing further. The mechanics are in [Where your notes live](#where-your-notes-live);
the customer-facing version is the privacy policy's "How long it is kept" and the
deletion page, both of which say this only on an instance that keeps backups
(`backups` in `/api/config`, true where a `BACKUPS` bucket is bound). A fork with no
bucket makes no dumps and has no mirror (the first two rows of the table still hold)
and its documents describe only that. The Worker cannot see whether the mirror workflow
runs, so a fork that binds a bucket and never sets the mirror up has its documents
overstate the off-account half; such a fork should publish its own, as `legal/documents.ts`
says of every operator the built-in text does not fit.

**What is kept, and where.** Each account's notes are in a store of their own on
Cloudflare, its files in R2 and the account records in D1, all in one Cloudflare
account. Beyond the live copy:

| Copy | Where | Kept |
| -- | -- | -- |
| The store's own history, for winding back | Cloudflare, in the store | 30 days |
| A deleted file's bytes, under a tombstone the store keeps | The live bucket | 35 days |
| A daily dump of every account whose store changed, and of every account at least weekly | A backups bucket in the same account | 14 days |
| Those dumps, copied nightly | A second Cloudflare account | 90 days |
| Every file, copied nightly | The second account | Until 55 days after the file leaves the live bucket |
| The D1 export: sign-in, connected apps, the account directory | The second account | 90 days |

The nightly copy is made by a GitHub Actions job on a GitHub-hosted runner, pulling from
outside with a read-only credential: **your files pass through that runner on the way to
the second account**, and none of your content is kept on it. The copies in the second
account sit under a thirty-day retention lock, so the credential the job uses, or a
leaked copy of it, cannot overwrite or delete one younger than that; an administrator of
that account can still change the rule, or close the account, which is what the two
accounts being separate is for. Worker secrets are in no backup. The mirror has run on
its schedule once, on 7 October 2026, green; it has not yet shown a week of nights, which
is what MAK-171 asks for before it closes.

**What a deletion means.** Emptying the trash removes a note's rows at once and its files
thirty-five days later; a deleted account's files go at once. Neither touches the
backups, which age out on their own: a dump fourteen days after it was written
on-account and ninety days after the night it was copied off-account, a file fifty-five
days after the night it was first seen gone from the live bucket, a D1 export ninety days
after its night. The last copy of a note purged today is therefore the dump written this
morning, copied tonight, deleted ninety days on: **a deleted note or a deleted account is
gone from every copy within about three months**, ninety-one or ninety-two days at the
longest, which the customer-facing text rounds to "about three months" rather than
promising a number the lifecycle rule can miss by a day. A note's history is in the dumps
too, so **Clear history** is final once they have aged out, not before.

**What each way back loses.** Nothing here is a merge; each puts an account back as it
was at some moment and loses what came after.

- *Winding the store back*, to a moment in the last thirty days: everything written after
  that moment, and nothing else: files follow the store through their tombstones, so a
  file deleted since is the note's again. Reversible for thirty days by the undo bookmark.
- *Loading a dump*, for a fault noticed too late to wind back: everything since the dump
  was taken, which is up to a day; the store's thirty days of history and its undo
  bookmarks; and the live copy of a file deleted more than thirty-five days before the
  dump, which comes back from the mirror by the restore-files workflow. Reversible for
  thirty days by the store's bookmark, and the store as it stood is dumped first.
- *Losing the whole Cloudflare account*, the runbook under Where your notes live: about
  a day of notes, and more if the account is lost after the morning's dump and before the
  night's copy of it; every file uploaded since the night's copy; every store's history;
  and every session, so everyone signs in again. Files deleted in the fifty-five days
  before should come back as orphans the sweep reclaims; that part was not rehearsed.

None of these is a way to bring one note back. That is the trash, History in a note's
⋯ menu, and the [export](backups.md#backups-and-export) in your own hands.

**What has been rehearsed, and what has only been dry-run.** On the dev instance on
7 October 2026, with counts checked before and after: notes purged and a file deleted,
the store wound back to the minute between and the files serving their bytes again; the
undo of that, both as a wind-back by time and by the bookmark; a day-old dump loaded, with
the before-load dump listed, and that load undone; and steps 1 to 5 of the whole-account
runbook into a scratch Worker in the second account, with the dumps loading to counts
identical to dev. On 8 October, restore-files for real: a throwaway account's one file,
copied to the mirror by a hand-started mirror run, deleted from the live bucket by hand,
and put back by the workflow with `RESTORE`: one file in the mirror, one copied, byte
for byte the object that was deleted. Dry-run only: the runbook's step 6, new credentials
for a new account and a hand-started mirror, which is designed and not proven. The
write-ups are on MAK-171 and MAK-200.

## Blob garbage collection

R2 has no foreign keys, so objects can outlive their metadata: a crash between the upload
and the metadata insert, or a store wiped without its prefix having been swept first.
`POST /api/admin/gc-blobs` reads every key the caller's note store references, sweeps the
caller's own prefix and reports what it finds; add `?apply=1` to delete. It is scoped to
`users/{caller}/` by design, so it can never see or remove another account's objects.
