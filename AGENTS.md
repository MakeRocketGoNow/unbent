# Working on Unbent

Guidance for agents working in this repo. The [README](README.md) explains what the app is
and why the editor is built the way it is — read it before touching the editor. This file
is about *how to work here*: the standards this project holds, and the corrections that
have come up often enough to be worth writing down.

## The bar for UI work

**This project is held to a high UX standard. Assume the UI matters more than the
implementation.** The most common feedback in this repo's history is that something works
but doesn't feel right — spacing that is "really inconsistent", a control that is "not
obvious", an interaction that is "janky", an action that "should be aligned right". Budget
real time for this. A change that functions but looks unconsidered is not done.

Some things that have been asked for repeatedly, so start from them:

- **Make affordances obvious.** If a control is clickable, it must look clickable. "It's not
  obvious that tags is clickable" and "you have to know that you're clicking in an invisible
  area" were both bugs worth fixing properly, not with a tooltip.
- **Actions are buttons; navigation is links.** See [Buttons](#buttons) below.
- **Nothing should jump.** When a control opens an editor, the editor appears where the
  control was — not somewhere else on the row. Motion the user didn't ask for reads as jank.
- **Rhythm over local fixes.** Vertical spacing gets judged as a whole. When several elements
  stack, give them one rhythm instead of tuning each gap until it looks acceptable alone.
- **Mobile is a real target, not a fallback.** A large share of this project's UI work has
  been phone layout. Check every change at both breakpoints. Long content — an email
  address, a filename, a tag list — must be assumed unbounded; it has broken the layout more
  than once.
- **Dark mode is a real target too.** Both themes are defined in `styles.css`. `--bad` is a
  light salmon in dark mode, so anything filled with it needs dark text, not white.
- **Density belongs to the content.** Controls that repeat on every row of a list should be
  quieter than controls that appear once per view.

When a UI decision has a real trade-off, say so and give a recommendation. Asking for "an
unbiased opinion" as "a principal frontend engineer and expert UX designer" is a recurring
request here — the useful answer names the trade-off and then picks, rather than listing
options. Push back when the proposed fix treats a symptom; that has been welcomed.

## Buttons

Use the `Button` component (`apps/web/src/components/Button.tsx`) for anything that *does*
something. Do not style a `<button>` as a link.

A link navigates and can be middle-clicked, opened in a new tab, and copied. A button
changes something and can do none of those. Drawing one as the other — which this codebase
did with `<button className="link">` — gives a control no padding, no hit area beyond its
text, and a hover underline promising a navigation that never happens. It teaches people to
distrust both.

```
variant="primary"     Filled. The one thing a view is for. At most once per view.
variant="secondary"   Outlined. A real action that isn't the main one. The default.
variant="quiet"       No border until hover. For actions in dense rows and toolbars.
tone="danger"         Destructive. Layers onto any variant.
size="small"          Denser, for rows and toolbars.
```

`variant` is how loud, `tone` is what it does — they are independent. "Delete forever" in a
list row is `quiet` + `danger`; "Empty trash" in a confirm is `primary` + `danger`. This is
the same `tone` vocabulary `Confirm` uses for its actions.

Genuine navigation stays a `<Link>` or `<a>` and should look like one. `Button` deliberately
does not render anchors.

Older filled buttons still use the bare `.primary` class. It is the same shape and radius as
`.btn-primary` on purpose; convert callers to `Button` opportunistically when you are already
editing them, not in a sweep.

`<button className="link">` still appears in several places — `Confirm`'s own secondary
action and cancel, `Import`, `Attachments`, `Workspace`, `Settings`. Those predate this
component and are the backlog it exists to work through, not counterexamples to it.

## Icons

Icons come from [lucide](https://lucide.dev), and every one of them passes through
`apps/web/src/components/icons.tsx`. Import the named components from there — `TagIcon`,
`CalendarIcon` and so on — and never `lucide-react` directly from a component. The file is
the single seam: it fixes each icon's size against what it sits beside (a lone control in a
44px target, a label beside a row of text, a cross inside a chip), and it is the one place
to change if the library ever changes again.

They were hand-drawn until the fifteenth. The first dozen were a few straight lines each,
which no library would have drawn better; the tag and the calendar were traced from
Android's drawables by eye, which is exactly the work an icon set exists to save, and the
next feature wanted eight more. lucide's defaults are the geometry the hand-drawn set
already had — a 24×24 box, `currentColor` at stroke width 2, round caps and joins — so the
switch changed no pixels that mattered.

The editor toolbar's own glyphs still go through `ToolbarIcon` with paths, deliberately:
bold, italic and the rest are letters in that toolbar, and the few real icons beside them
are drawn to match those letters rather than a library's weight.

Don't add a second icon library, and ask before adding any other dependency.

## Destructive actions

Every destructive action goes through the `Confirm` component. It is inline, not modal, and
that is deliberate: every confirmation here is about something specific on screen — a named
notebook and its note count, a trash with a number in it — and a modal covers the very thing
being decided about.

Name the blast radius before the user commits: how many notes, which notebook, what happens
to attachments. `Confirm` weights its actions by position, so a destructive action passed
after a safe one demotes itself automatically — pass them in the right order and don't
override the classes.

## Comments

Comments here explain **why**, and they are unusually thorough — read a few before writing
any. The house style records the decision and the alternative that was rejected, so the next
person doesn't re-litigate it or silently undo it. `Rail.tsx`, `OverflowMenu.tsx` and
`Confirm.tsx` are good examples.

Write them for the reader who is about to change the code. If a line looks arbitrary and
isn't, say why. If something was tried and didn't work, that belongs in the comment.

## Real notes stay out of the repo

**This repository is open source; the notes it is built against are private.** The real
corpus — the Evernote export, the notes on unbent.app, anything read through the MCP tools,
a screenshot or a pasted bug report — is someone's personal archive. Nothing from it goes
into anything that gets pushed: code, tests, fixtures, comments, docs, commit messages, PR
titles and descriptions, or review comments.

That is broader than it sounds. A filename, a note title, a notebook or tag name, a person's
or business's name, an address, an amount: any of them can say something about someone's
life they never chose to publish. A commit message is as public and as permanent as the
code, and harder to take back — rewriting history on `main` is a much bigger job than
editing a file.

When a real note is what exposed a bug, keep its *shape* and invent the content. What
matters to a parser is "capitals with a parenthesized word in the middle, inside an
angle-bracket destination", and `SAMPLE INVOICE (ACME) Final Copy.pdf` proves that as well
as the original did. In prose, say "an imported PDF" or "a note in the real corpus" rather
than quoting it. Prefer placeholders that are obviously made up — `Acme`, `example.com`,
`Report (final) v2.pdf` — over ones that merely sound plausible.

If you find real content already in the repo, say so rather than quietly working around it.

## Commits

Atomic commits, one logical change each. This has been asked for explicitly and more than
once.

The subject line says what changed **for the user**, in plain language, as a sentence:

> Let the editor's PDF page count expand to show every page.
> Keep the divider under the pointer while dragging
> Show where a dragged file will land.

Not `feat(editor): add PDF expansion`. The body explains what was wrong before, what the
change does, and any non-obvious reasoning — the same "why" standard as the comments.
Describe the case that broke without quoting a real note; see
[Real notes stay out of the repo](#real-notes-stay-out-of-the-repo), which applies to PR
descriptions as much as to commits.

**Commit atomically as you go.** Don't accumulate a session's work into one commit at the
end, and don't wait to be asked for each one — when a logical change is complete and
verified, commit it. Each commit should stand on its own: the tree builds and typechecks at
every one, not only at the tip.

Stage only what this session touched. A working directory often carries edits from another
terminal or an unfinished task, and `git diff` cannot tell those apart — only the session
can. Prefer explicit paths over `git add -A`, and if `git status` shows files you didn't
touch, leave them and say what you skipped.

The user also has a `msg-and-commit` skill for the same job on demand, which scopes a
message to the session's changes. It lives in their environment, not in this repo, so it
may not be available to you — the rule above is the same either way.

**Pushing is still on request.** Committing as you go is the default; pushing and opening a
PR are not. Don't push unprompted.

The exception is work started from a Linear issue: asking for an issue to be fixed is asking
for the PR, so push and open one once the change is verified, then move the issue to In
Review. Stop at the commit only when the change is one the user will want to try locally
before review — in practice, Android changes, which only prove themselves on a device. Web,
API and docs changes are verified in the browser and the test suites, and go straight to a
PR. The `fix-linear-issue-cloud` skill carries the full loop.

## Running things

**Do not leave background processes running.** This has been raised sharply. Don't
`nohup`, don't background a dev server, don't leave watchers behind.

The dev server is usually the user's, on :5173 (web) and :8787 (API) — those are the *main
checkout's* ports. **Check before starting your own:**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/
```

If it's already up, use it. If you do start something, stop it when you're done. Use the
browser preview tools rather than `bash` for anything server-shaped.

From a worktree the ports are different and derived — `pnpm dev` prints them on its first
line, and `node scripts/ports.mjs` answers without starting anything. Never assume 5173,
and don't cache the answer either: a worktree's pair is derived from its name but these
bands belong to the whole machine, so when something else is already on one, `pnpm dev`
steps to the next free pair and says `(its usual pair was taken)`. The line it prints is
the truth; the derived pair is only where it started looking.

### Working from a git worktree

Branch work often happens in a worktree beside the main checkout — prefer one over
switching branches in place, so the user's checkout and dev server stay where they are.

**Branch off a freshly synced `main`.** A local `main` is stale as often as not, and a
branch cut from it starts behind, which shows up later as conflicts or as a review of code
that was already changed on `origin`. Fetch first and branch from the remote ref, rather
than assuming the local one is current:

```bash
git fetch origin
git worktree add -b <branch> <path> origin/main
```

The README's Worktrees section has the rest of the mechanics. **Run `pnpm worktree:setup`
once in a new worktree**, before anything else. `git worktree add` brings tracked files and
nothing else, so until then the worktree has no `.dev.vars` (the Worker
starts with no `BETTER_AUTH_SECRET` and no OAuth credentials), no dependencies, and no
local database. The setup script copies those across and seeds D1 and R2 from the main
checkout, then prints the ports.

A Claude session that starts in a worktree does this for itself: the `SessionStart` hook in
`.claude/settings.json` runs `scripts/worktree-autosetup.sh`, which calls
`pnpm worktree:setup --fresh` when the worktree has no dependencies or no local D1 yet, and
does nothing in the main checkout or in a worktree already set up. `--fresh` always — an
empty database, not a copy of the user's notes; copying the real corpus stays a command a
person runs on purpose. Its output is in the session's context, so check it for the ports
rather than assuming the setup still needs doing.

`pnpm dev` in a worktree runs *both* halves on that worktree's own pair, so the branch's
API code is what answers and its notes and auth config are the worktree's own — not the
main checkout's Worker on :8787. That is a change from how this used to work; there is no
longer a reason to point a worktree's Vite at someone else's API.

The state a worktree starts with is a copy taken at setup time, so the two databases drift
apart from there. Don't expect a note created in one to appear in the other, and don't
reach for `--persist-to` to share them: two Miniflare processes on one SQLite file is not
something Miniflare promises to survive.

`.claude/launch.json` is untracked and written per checkout by `scripts/dev.mjs`, so the
preview tool's `unbent` entry starts and opens whichever checkout you are in.

That last part depends on the session having *started* in this directory. The preview tool
resolves its project root once, when the session begins, and switching into a worktree
partway through moves the shell without moving it — so `preview_start` reads the main
checkout's `launch.json` and reports a conflict on :5173 that has nothing to do with the
branch. There is nothing to fix in the repo when that happens, and deleting the main
checkout's file only breaks the preview there too. Start the session in the worktree if
you want the preview tool, and otherwise run `pnpm dev` and drive the printed URL directly.

To point the API suites at a worktree, pass both origins — `API_URL` is the Worker,
`APP_URL` is the SPA origin the tests send as `Origin`:

```bash
API_URL=http://localhost:8817 APP_URL=http://localhost:5217 \
  pnpm --filter @unbent/api exec vitest run test/isolation.test.ts
```

### The Android emulator is the user's — never launch it yourself

**Do not start an emulator.** `pnpm android:build` builds, installs and launches the debug
app; `pnpm android` launches what is already installed. Both boot an AVD only if none is
running, and that fallback is for a human at a keyboard, not for you. If `adb devices` is
empty, **stop and ask the user to start it** from Android Studio's Device Manager or by
running those scripts in their own terminal.

An emulator launched from an agent's shell has no macOS GUI session. It looks fine — it
renders, it boots, `adb` input works, screenshots come back — so it is easy to believe it
is healthy. But its window silently discards every real mouse click, logging
`skipping QEventPoint ... : no target window`. The user is left with an emulator that
ignores them while you report success from `adb`. If you find that line in the log, the
emulator was started wrong; it cannot be fixed from here, only relaunched by the user.

The scripts pass `-no-snapshot-save` deliberately, and the flag is load-bearing in both
directions: it *loads* the saved `default_boot` snapshot — which is where the emulator's
signed-in session lives — and does not write over it on exit. Hand-rolling the launch
inverts both halves. `-no-snapshot-load` cold-boots to a signed-out app, and without
`-no-snapshot-save` the emulator then overwrites `default_boot` on quit with that
signed-out state. That trades a working, signed-in emulator for one that has to be set up
again, and there is nothing to roll back to afterwards.

The AVD is `Pixel_9_API_36` (`AVD_NAME` overrides it). Take it from the scripts rather than
inferring it from what is installed or when files were last touched.

Two builds sit side by side on the device. The **orange** icon is
`com.makerocketgonow.unbent.debug`; the **green** one is `com.makerocketgonow.unbent`, the release build,
which is signed into **production**. Drive the debug one. Never tap through the release app
— a stray tap there writes to the user's real notes.

And do not navigate by guessing coordinates. Blind `adb shell input tap` calls land on
FABs and list rows and create notes nobody asked for. Read the bounds first:

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml
```

Everything past sign-in and the share sheet is the site in a WebView, so most of what is on
screen is a page. Debug builds turn on WebView debugging: `chrome://inspect` on the Mac
lists the app's page, where its DOM, console and network can be read like any tab's.

### Sample notes, and shooting the app

**Check which instance the app is pointed at before creating anything.** The debug build
stores an instance per install and it is often `https://unbent.app` — the user's real
notes. App settings shows the address — the site's Settings → App settings inside the app,
or a long-press on the launcher icon — and so does the sign-in screen's footer. Prefer a
local instance for anything that writes.

`pnpm seed:demo` creates `demo@example.com` on this checkout's dev server and fills it with
ten presentable sample notes. It is idempotent, so re-running updates rather than
duplicates; `--reset` clears the account's notes first, and `--url` aims it somewhere else
on localhost. It refuses any host that is not loopback, because it signs up a password
written down in the script. Sign-up works because `pnpm dev` passes
`ALLOW_TEST_CREDENTIALS=1` to the Worker — local only, see `passwordEnabled` in
`apps/api/src/auth.ts`.

Point the app at that instance from App settings → Unbent address, or the sign-in screen's
Change. Use `adb reverse tcp:<port> tcp:<port>` and the plain `http://localhost:<port>`;
the dev servers bind loopback, so `10.0.2.2` does not always reach them, and a worktree's
port is not 5173 (`scripts/ports.mjs`).

**Switching the address needs a sign-in on the new instance, and keeps the old one.**
Sessions are stored per origin: a debug app switched from production to a local instance
asks for a sign-in there, and switching back finds the production session where it was
left. Say which instance the app is on when you hand it back.

Store screenshots must not show the debug name. `resValue("string", "app_name", …)` in
`apps/android/app/build.gradle.kts` makes the debug build "Unbent (debug)"; set it to
"Unbent" for the build you shoot, then **revert it and confirm `git diff` on that file is
empty**. Existing assets and the full recipe are in `apps/android/store/`.

`adb exec-out screencap -p > shot.png` captures without a temporary file on the device.
`uiautomator dump` returns empty while the app is mid-animation or busy — let it settle
rather than treating the empty file as a missing element.

### Three keys sign this app, and Google has to know all of them

Debug builds use the local debug keystore, uploads are signed with the release key in
`~/.config/unbent`, and **Play re-signs every bundle with its own App Signing key** — so
what users install is signed by a certificate that never existed on this machine.

Anything keyed on a signing certificate therefore needs the Play key registered too, not
just the upload key:

- **The `ANDROID_ASSET_LINKS` secret on the Worker**, which is what the instance serves at
  `/.well-known/assetlinks.json` — SHA-256, or App Links open in a browser instead of the
  app, and passkeys stop being offered. It is a per-deployment secret rather than a file,
  because a fork's instance must not vouch for this repository's app; put it on production
  with `wrangler secret put`, and the `ANDROID_ASSET_LINKS` repository secret carries it to
  the dev instance and previews.
- **The Android OAuth client**, in the Google Cloud console — SHA-1. When it is missing,
  Google refuses to issue an ID token and Credential Manager reports `NO_CREDENTIAL`,
  which is indistinguishable from a phone with no Google account. Sign-in appears broken
  only in the store build; every local release build works, because the upload key *is*
  registered.

Both fingerprints come from the app's App signing page in Play Console — search the console
for "app signing" rather than following a menu path, which has moved more than once. Take
them from the **Classical key** column; the post-quantum one beside it is a beta that
neither the OAuth client nor Digital Asset Links accepts. Registering the upload key alone
is the trap: it makes every build you can test locally work.

### Shipping to Play

Pushes to `main` build a signed bundle and upload it to the closed testing track as a
**draft** — it appears in Play Console and passes Play's checks, but nobody receives it
until a person promotes it. Making testers get it automatically is a one-word change
(`status: completed` in `.github/workflows/android.yml`).

Never build a bundle by hand for Play. A local build gets `versionCode = 1`, which Play
rejects as a duplicate; CI takes the run number, which is unique and always rising.

The publish needs `PLAY_SERVICE_ACCOUNT_JSON` alongside the keystore secrets, and skips
cleanly without it. Play also requires **one bundle uploaded by hand** before the API will
accept any — a brand new app or a renamed `applicationId` has to be primed that way once.

## Verifying

Verify UI changes in the browser and show the result — don't ask the user to check
manually. Screenshot the change, and confirm computed styles when the point of the change is
visual. Test both breakpoints when layout is involved.

`pnpm --filter @unbent/web test` and `npx tsc --noEmit` both need to pass. Don't mutate the
user's real data to test a control; if you do it by accident, put it back and say so.

`apps/android` is outside the pnpm workspace — `pnpm -r` silently skips it, so nothing above
verifies it. It is checked with `cd apps/android && ./gradlew test`, which needs no device.
The app is the site in a WebView, so almost every UI change belongs in `apps/web` and
reaches the phone on deploy. Check it at phone width and inside the app — Back, the system
bars and the keyboard are the app's, not the browser's. What stays native is the sign-in
screen, the share sheet and App settings, and the UI rules in this file apply to those
Compose screens as much as to the site.

## The local database is disposable — but ask

Wiping local notes during development is fine and has been offered explicitly. **Ask first
every time**, because the plan is one final import from the real Evernote corpus and the
state may have changed since the last conversation. "The database" is D1 and the note
stores under `.wrangler/state/v3/do/` together; `db:reset` and `reset:local` clear both.

That corpus is ~3 GB and ~13K notes, mostly PDFs — this is a paperless-office use case.
Performance assumptions should hold at that scale, not at the scale of a dev database with
90 notes.

## The per-account note store

Every account's notes live in one SQLite-backed Durable Object per user — `UserStore` in
`apps/api/src/store/`, reached through `reposFor` in `lib/repos.ts`. D1 keeps the control
plane: Better Auth's tables, OAuth and MCP clients, upload grants, and the account
directory. The object is the repository: `NotesStore` and `AttachmentsStore` hold the SQL,
with no `user_id` anywhere, because the database is the user; `lib/notes-repo.ts` and
`lib/attachments-repo.ts` are facades over the stub, one RPC call per method, keeping the
signatures every route and tool was written against. The decision and its reasons are in
MAK-128; the short version is that the sync change feed and note history are storage
features, and building them on D1 and then porting would be paying twice. The README's
"Where your notes live" is the user-facing account of the same thing.

A change to the notes data plane is a change in `store/`, and usually nothing else: the
facade is one line per method. A new query goes into the store with a rows-read bound in
`apps/store-tests`; a new thing a route needs in one request goes on `UserStore` as a
composite and on the facade as a passthrough.

Five rules, held by tests where a test can hold them:

1. **The object touches its SQLite and nothing else.** No `fetch`, no R2 bytes, no
   AI/Anthropic/Typesafe calls in `src/store/`. Those happen in the Worker before or after
   the object call. Blob *keys* go through the object (it owns `attachments`); bytes never
   do. `StoreEnv` names nothing, so the compiler refuses a binding, and `guards.test.ts`
   reads the source for the rest.
2. **Ids stay globally unique UUIDs** even inside a per-user database. `(owner, id)` is the
   key any future sharing would use, and export/import keeps working across accounts.
3. **The owner's object is the source of truth.** If sharing ever comes, a grantee reads
   and writes through the owner's object; the grantee's holds a shortcut. Nothing to build
   now.
4. **The change feed is per user with a sequence cursor**, never global. `_meta` reserves
   `seq` for it. Nothing to build now.
5. **Each RPC call is a billable object request.** Prefer a composite method on `UserStore`
   (`listPage`, `exportPage`, `getWithFiles`, `notebooksOverview`, …) to a second call in
   the same request, and check calls per page load when adding a route.

Things about working on the store that are easy to get wrong:

- **Schema files are append-only.** `store/schema/0001-init.ts` is applied once per object
  and never edited again; a change is a new `0002-<name>.ts` appended to `SCHEMA`, additive,
  applied on each object's next wake. There is no down migration. After a deploy that
  carries one, run the sweep (`POST /api/admin/store/sweep`, operator only, one batch per
  call until `done`) so every object migrates now and a failure is in the log today.
- **Object tests need a fresh object each.** The vitest plugin's storage isolation does not
  reach SQLite-backed objects, so `freshStore()` in `apps/store-tests/test/helpers.ts` mints
  a random name per test. Never name an object in a test.
- **The directory is the only thing that can turn a wipe on.** The sweep wipes an object
  only for a tombstoned directory row or one whose `user` row is gone; a missing row never
  wipes anything, and a row is dropped only once the user row is gone too. Keep it that
  way.
- **Subrequests are the budget inside one invocation.** Fifty on Free, and every D1 query
  and every store call counts. The sweep walks twenty accounts a run at two store calls
  each; the operator's `dump` route makes forty store calls at most; anything new that
  loops over accounts or pages D1 needs the same shape. CPU is a budget too — ten
  milliseconds an invocation on Free, thirty seconds inside an object — so work over a big
  result, like turning a dump page into SQL text, is done in the object and forwarded.
- **Nothing periodic may scan a table.** The sweep reads `usage()` — the one `note_counts`
  row and the database size — never `stats()`, which counts every table and is the
  operator's. An hourly `stats()` on an archive-sized account would read every row of it
  twenty-four times a day. The rows-read test bounds `usage` at a handful.
- **A new D1 index changes other statements' plans, not only the one it was added for.**
  The planner has no statistics, so an index is taken by every statement on its table
  that can use its first column: at the cutover, a plain `user_id` index added for the
  copy turned a file lookup by note into a read of every file of the account. Before
  adding one, `EXPLAIN QUERY PLAN` the table's other statements on a SQLite built from
  `apps/api/migrations/` (`migrations.test.ts` shows how), and prefer an expression
  index, which only its own spelling can use.
- **Local state is D1 *and* `do/`.** The reset scripts clear both; clearing one by hand
  leaves ghost objects. `worktree:setup` copies both.

## Rows read are still the budget

Production runs on Workers Free, where the rows a Durable Object's SQLite reads and writes
are metered as D1's were, and the shared database ran out of its daily reads twice in one
week before the query plans were fixed. So a change to a query is judged by the rows it
reads on an archive-sized store, not by whether it returns the right rows. The accounting
is the `[store]` log line the `Sql` seam writes for any statement over two thousand rows,
with the user id and the statement; `POST /api/admin/store/sql` runs `EXPLAIN QUERY PLAN`
against a real account; and the rows-read test at the end of
`apps/store-tests/test/notes-store.test.ts` bounds every hot query on a three-thousand-note
store. A new query belongs in that test.

The planner has no statistics (there is no `sqlite_stat1`) and takes the first column of an
index to be selective. Every notes index leads with `deleted_at`, which matches every live
note, so `+deleted_at` — the unary plus keeps that column's index out of the plan while the
condition still applies — is written wherever an `id IN (…)` run or a tag filter is the
way in, and `+n.notebook_id` beside a tag filter for the same reason. `liveCondition` in
`store/notes-shared.ts` is where it is applied. Measure a new index or a `+` against a tiny
notebook as well as the big case; on the shared database a global index once made a
30-note notebook read 13k rows.

D1 serves the control plane only — the note tables were dropped by migration 0036 after
the cutover — and its reads still count against the same daily total.

Do not run `PRAGMA optimize` or `ANALYZE` on production, whatever the documentation
suggests — not on D1, and not inside an object. Measured on a copy of the archive, the
statistics they write made the image-queue queries two to three times worse, and a full
`ANALYZE` reads about 572k rows on its own. The plans this codebase depends on are pinned
in SQL instead; the read-only SQL route refuses a `PRAGMA` for this reason among others.
