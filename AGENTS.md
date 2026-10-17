# Working on Unbent

Guidance for agents working in this repo. The [README](README.md) explains what the app is,
and [docs/editor.md](docs/editor.md) why the editor is built the way it is. Read that before
touching the editor. This file is about *how to work here*: the standards this project
holds, and the corrections that have come up often enough to be worth writing down.

References like MAK-123 point at the maintainer's private Linear tracker, which nobody
outside can read. Where a decision matters, its reason is carried inline (in the comment,
the commit or the README) and the reference is only where the discussion happened; a bare
one is a pointer for the maintainer, not something you are expected to look up.

## The bar for UI work

**This project is held to a high UX standard. Assume the UI matters more than the
implementation.** The most common feedback in this repo's history is that something works
but doesn't feel right: spacing that is "really inconsistent", a control that is "not
obvious", an interaction that is "janky", an action that "should be aligned right". Budget
real time for this. A change that functions but looks unconsidered is not done.

Some things that have been asked for repeatedly, so start from them:

- **Make affordances obvious.** If a control is clickable, it must look clickable. "It's not
  obvious that tags is clickable" and "you have to know that you're clicking in an invisible
  area" were both bugs worth fixing properly, not with a tooltip.
- **Actions are buttons; navigation is links.** See [Buttons](#buttons) below.
- **Nothing should jump.** When a control opens an editor, the editor appears where the
  control was, not somewhere else on the row. Motion the user didn't ask for reads as jank.
- **Rhythm over local fixes.** Vertical spacing gets judged as a whole. When several elements
  stack, give them one rhythm instead of tuning each gap until it looks acceptable alone.
- **Mobile is a real target, not a fallback.** A large share of this project's UI work has
  been phone layout. Check every change at both breakpoints. Long content (an email
  address, a filename, a tag list) must be assumed unbounded; it has broken the layout more
  than once.
- **Dark mode is a real target too.** Both themes are defined in `styles.css`. `--bad` is a
  light salmon in dark mode, so anything filled with it needs dark text, not white.
- **Each colour means one thing.** The accent (`--accent`, a muted magenta) is what acts:
  a primary button, a link, a selection, a focus ring. `--good` green is only success and
  `--bad` red only failure or destruction. The accent was green until 2026-10-17, when a
  primary action and a success state looked the same; don't spend it on data (tags wear
  their own stored colour) or on a state.
- **Red does not share a box with the accent or with green.** A red border around a
  primary button reads as a warning about something safe (and, when the accent was green,
  as Christmas). See [Destructive actions](#destructive-actions).
- **Density belongs to the content.** Controls that repeat on every row of a list should be
  quieter than controls that appear once per view.

When a UI decision has a real trade-off, say so and give a recommendation. Asking for "an
unbiased opinion" as "a principal frontend engineer and expert UX designer" is a recurring
request here: the useful answer names the trade-off and then picks, rather than listing
options. Push back when the proposed fix treats a symptom; that has been welcomed.

## Buttons

Use the `Button` component (`apps/web/src/components/Button.tsx`) for anything that *does*
something. Do not style a `<button>` as a link.

A link navigates and can be middle-clicked, opened in a new tab, and copied. A button
changes something and can do none of those. Drawing one as the other, which this codebase
did with `<button className="link">`, gives a control no padding, no hit area beyond its
text, and a hover underline promising a navigation that never happens. It teaches people to
distrust both.

```
variant="primary"     Filled. The one thing a view is for. At most once per view.
variant="secondary"   Outlined. A real action that isn't the main one. The default.
variant="quiet"       No border until hover. For actions in dense rows and toolbars.
tone="danger"         Destructive. Layers onto any variant.
size="small"          Denser, for rows and toolbars.
size="large"          44px tall, for the few actions of a state that stands alone.
```

`variant` is how loud, `tone` is what it does. They are independent. "Delete forever" in a
list row is `quiet` + `danger`; "Empty trash" in a confirm is `primary` + `danger`. This is
the same `tone` vocabulary `Confirm` uses for its actions.

Genuine navigation stays a `<Link>` or `<a>` and should look like one. `Button` deliberately
does not render anchors.

The one exception is a view's or a state's single call to action that navigates: it may
be a `<Link>` wearing the button classes (`btn btn-primary` when it is the thing the view
is for, `btn btn-secondary` when it is only the way out). It is still a real link (it
middle-clicks, opens in a new tab and copies) and only borrows the button's shape.
`FrontPage`'s sign-up and `EmptyLibrary`'s import are filled; `NotebookMissing`'s "Show all
notes" is outlined. That is the stylesheet lending a link a shape, not a reason for
`Button` to render anchors.

Older filled buttons still use the bare `.primary` class. It is the same shape and radius as
`.btn-primary` on purpose; convert callers to `Button` opportunistically when you are already
editing them, not in a sweep.

`<button className="link">` still appears in several places: `Confirm`'s own secondary
action and cancel, `Import`, `Attachments`, `Workspace`, `Settings`. Those predate this
component and are the backlog it exists to work through, not counterexamples to it.

## Icons

Icons come from [lucide](https://lucide.dev), and every one of them passes through
`apps/web/src/components/icons.tsx`. Import the named components from there (`TagIcon`,
`CalendarIcon` and so on) and never `lucide-react` directly from a component. The file is
the single seam: it fixes each icon's size against what it sits beside (a lone control in a
44px target, a label beside a row of text, a cross inside a chip), and it is the one place
to change if the library ever changes again.

They were hand-drawn until the fifteenth. The first dozen were a few straight lines each,
which no library would have drawn better; the tag and the calendar were traced from
Android's drawables by eye, which is exactly the work an icon set exists to save, and the
next feature wanted eight more. lucide's defaults are the geometry the hand-drawn set
already had: a 24×24 box, `currentColor` at stroke width 2, round caps and joins, so the
switch changed no pixels that mattered.

The editor toolbar's own glyphs still go through `ToolbarIcon` with paths, deliberately:
bold, italic and the rest are letters in that toolbar, and the few real icons beside them
are drawn to match those letters rather than a library's weight.

Don't add a second icon library, and ask before adding any other dependency.

Updating one is done by hand, not by Dependabot: read [DEPENDENCIES.md](DEPENDENCIES.md)
first, which names every version held back and why, and add to it when you hold one.

## Tooltips

A control's tooltip is `data-tip`, not `title`. `apps/web/src/tooltips.ts` listens once on
the document and draws every `data-tip` in the app's own bubble after a short rest, at once
for the next control in the same sweep, on keyboard focus, and never on touch. A native
`title` waits over a second, every time, which made a row of icons a guessing game.

Every icon-only control gets one, alongside its `aria-label`: the tip is drawn, the label
is the name. The one exception is the × inside a chip: the chip already names what it
removes, and a bubble on every chip's cross in a row of them would be noise. A tip that
says more than the name (why a control is faded, above all) must be read out too:
`Button`'s `tip` prop writes `data-tip` and `aria-description` together, and a raw
`<button>` sets both itself. A disabled button cannot be focused, so a reason that is only
drawn never reaches a screen reader. `data-tip-side="right"` puts it beside a control in a
column of them, like the rail's strip. `title` stays only on text an ellipsis may cut
short, where a fast bubble would flash over every row a pointer crosses.

## Destructive actions

Every destructive action goes through the `Confirm` component. It is inline, not modal, and
that is deliberate: every confirmation here is about something specific on screen (a named
notebook and its note count, a trash with a number in it) and a modal covers the very thing
being decided about.

Name the blast radius before the user commits: how many notes, which notebook, what happens
to attachments. `Confirm` weights its actions by position, so a destructive action passed
after a safe one demotes itself automatically: pass them in the right order and don't
override the classes.

Red never shares a box with the accent. A confirm's border takes the tone of the action it
offers (the first one): red when that action destroys something, the accent when it is the
primary, plain when it is neutral. So "Keep 9 KB on this device?" is bordered in the accent, and
"Delete this notebook?" red. `Confirm` works this out itself (`borderTone`), which is why
nothing is passed for it: don't override its classes, and don't hand-roll a confirm-shaped
box with a border of your own. The border used to be red for every question, and a warning
colour around a safe action was the bug.

## Comments

Comments here explain **why**, and they are unusually thorough: read a few before writing
any. The house style records the decision and the alternative that was rejected, so the next
person doesn't re-litigate it or silently undo it. `Rail.tsx`, `OverflowMenu.tsx` and
`Confirm.tsx` are good examples.

Write them for the reader who is about to change the code. If a line looks arbitrary and
isn't, say why. If something was tried and didn't work, that belongs in the comment.

## No em-dashes

Do not write an em-dash (—) in anything new: comments, docs, commit messages, PR text,
UI copy, Linear issues. Use a comma, a colon, a full stop or parentheses instead. A run of
them is the tell that a model wrote the text, and this repository is read by people who
notice.

The existing text was swept once, on 2026-10-16, so one found now is new: take it out
where you find it. The few left are the character itself (a test input, a regex, an OCR
sample, a stored summary's separator), and the legal documents are the one place to leave
them where a lawyer would have used one, since that register is the point.

## Real notes stay out of the repo

**This repository is source-available; the notes it is built against are private.** The real
corpus (the Evernote export, the notes on unbent.app, anything read through the MCP tools,
a screenshot or a pasted bug report) is someone's personal archive. Nothing from it goes
into anything that gets pushed: code, tests, fixtures, comments, docs, commit messages, PR
titles and descriptions, or review comments.

That is broader than it sounds. A filename, a note title, a notebook or tag name, a person's
or business's name, an address, an amount: any of them can say something about someone's
life they never chose to publish. A commit message is as public and as permanent as the
code, and harder to take back: rewriting history on `main` is a much bigger job than
editing a file.

When a real note is what exposed a bug, keep its *shape* and invent the content. What
matters to a parser is "capitals with a parenthesized word in the middle, inside an
angle-bracket destination", and `SAMPLE INVOICE (ACME) Final Copy.pdf` proves that as well
as the original did. In prose, say "an imported PDF" or "a note in the real corpus" rather
than quoting it. Prefer placeholders that are obviously made up (`Acme`, `example.com`,
`Report (final) v2.pdf`) over ones that merely sound plausible.

If you find real content already in the repo, say so rather than quietly working around it.

## Commits

Atomic commits, one logical change each. This has been asked for explicitly and more than
once.

The subject line says what changed **for the user**, in plain language, as a sentence:

> Let the editor's PDF page count expand to show every page.
> Keep the divider under the pointer while dragging
> Show where a dragged file will land.

Not `feat(editor): add PDF expansion`. The body explains what was wrong before, what the
change does, and any non-obvious reasoning: the same "why" standard as the comments.
Describe the case that broke without quoting a real note; see
[Real notes stay out of the repo](#real-notes-stay-out-of-the-repo), which applies to PR
descriptions as much as to commits.

**Commit atomically as you go.** Don't accumulate a session's work into one commit at the
end, and don't wait to be asked for each one: when a logical change is complete and
verified, commit it. Each commit should stand on its own: the tree builds and typechecks at
every one, not only at the tip.

Stage only what this session touched. A working directory often carries edits from another
terminal or an unfinished task, and `git diff` cannot tell those apart: only the session
can. Prefer explicit paths over `git add -A`, and if `git status` shows files you didn't
touch, leave them and say what you skipped.

The user also has a `msg-and-commit` skill for the same job on demand, which scopes a
message to the session's changes. It lives in their environment, not in this repo, so it
may not be available to you: the rule above is the same either way.

**Pushing is still on request.** Committing as you go is the default; pushing and opening a
PR are not. Don't push unprompted.

The exception is work started from a Linear issue: asking for an issue to be fixed is asking
for the PR, so push and open one once the change is verified, then move the issue to In
Review. Stop at the commit only when the change is one the user will want to try locally
before review: in practice, Android and iOS changes, which only prove themselves on a
device. Web, API and docs changes are verified in the browser and the test suites, and go
straight to a PR. The `fix-linear-issue-cloud` skill carries the full loop.

## Running things

**Nothing runs that the user has not been told about.** The rule used to be "stop everything
when you're done", after sessions left servers behind with no sign they were there. That
fixed the wrong half: the server was then always down in the middle of a session, just when
the work was ready to be looked at. The trouble was never that something was running; it
was that nobody knew.

- **A dev server you started for the work stays up** while the work is open to review, so
  the user can open the change without asking for it back.
- **Say so at the end of every response while it is up**, in one line: that it is running,
  its address (the port `pnpm dev` printed, not an assumed one), and which checkout it
  serves. Every response, not only the one that started it: the line is how it gets
  cleaned up, and a server mentioned once is a server forgotten.
- **Stop it when the user says they are done**, when the branch is merged or abandoned, or
  when asked. `worktree-down` is how. Say that it is stopped.
- **Start it with the preview tools**, so the session holds a handle on it. Still never
  `nohup`, never a detached `&` from `bash`, and no watchers, one-off HTTP servers or
  anything else left behind: those are stopped in the turn that started them.

The dev server is usually the user's, on :5173 (web) and :8787 (API): those are the *main
checkout's* ports. **Check before starting your own:**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/
```

If it's already up, use it, and leave it as you found it: it is not yours to stop. Use the
browser preview tools rather than `bash` for anything server-shaped.

From a worktree the ports are different and derived: `pnpm dev` prints them on its first
line, and `node scripts/ports.mjs` answers without starting anything. Never assume 5173,
and don't cache the answer either: a worktree's pair is derived from its name but these
bands belong to the whole machine, so when something else is already on one, `pnpm dev`
steps to the next free pair and says `(its usual pair was taken)`. The line it prints is
the truth; the derived pair is only where it started looking.

### Working from a git worktree

Branch work often happens in a worktree beside the main checkout: prefer one over
switching branches in place, so the user's checkout and dev server stay where they are.

**Branch off a freshly synced `main`.** A local `main` is stale as often as not, and a
branch cut from it starts behind, which shows up later as conflicts or as a review of code
that was already changed on `origin`. Fetch first and branch from the remote ref, rather
than assuming the local one is current:

```bash
git fetch origin
git worktree add -b <branch> <path> origin/main
```

The Worktrees section of `docs/development.md` has the rest of the mechanics. **Run
`pnpm worktree:setup` once in a new worktree**, before anything else. `git worktree add`
brings tracked files and nothing else, so until then the worktree has no `.dev.vars` (the
Worker starts with no `BETTER_AUTH_SECRET` and no OAuth credentials), no dependencies, and no
local database. The setup script copies those across and seeds D1 and R2 from the main
checkout, then prints the ports.

A Claude session that starts in a worktree does this for itself: the `SessionStart` hook in
`.claude/settings.json` runs `scripts/worktree-autosetup.sh`, which calls
`pnpm worktree:setup --fresh` when the worktree has no dependencies or no local D1 yet, and
does nothing in the main checkout or in a worktree already set up. `--fresh` always: an
empty database, not a copy of the user's notes; copying the real corpus stays a command a
person runs on purpose. Its output is in the session's context, so check it for the ports
rather than assuming the setup still needs doing.

The desktop app runs that hook in the main checkout, not the worktree. It starts a
worktree's session with `--project-config-root` naming the main checkout, so what runs is
the main checkout's `.claude/settings.json` and its copy of the script, with the main
checkout as the working directory and as `CLAUDE_PROJECT_DIR`; the session's own folder
reaches a hook only as `cwd` in the JSON on its stdin. Two things follow for any hook here.
It takes its folder from that `cwd`, never from `pwd`, `git rev-parse` or
`CLAUDE_PROJECT_DIR`: reading its working directory is how the autosetup saw the main
checkout and did nothing for every new worktree from 2026-09-30 to 2026-10-17. And a
change to a hook or to the settings reaches desktop sessions only once the main checkout
has it, so try one by handing the script the input it will get, from the main checkout:

```bash
cd <main checkout> && echo '{"cwd":"<worktree>"}' | WORKTREE_AUTOSETUP_DRY_RUN=1 <worktree>/scripts/worktree-autosetup.sh
```

The app also clones the main checkout's root `node_modules` into a new worktree within a
few seconds of the session starting, but no workspace's: it looks for workspaces in
`package.json`, and pnpm keeps them in `pnpm-workspace.yaml`. A root `node_modules` is no
sign of an install; `apps/*/node_modules` is. A session that finds `wrangler` or `vitest`
missing all the same can read what the hook did in its own transcript
(`~/.claude/projects/<folder>/<session>.jsonl`): a `SessionStart` entry of type
`hook_success` or `hook_non_blocking_error`, or none at all when the script left without a
word. What the app copied and seeded is in its own log, `~/Library/Logs/Claude/main.log`,
under `worktreeDepSeed`.

`pnpm dev` in a worktree runs *both* halves on that worktree's own pair, so the branch's
API code is what answers and its notes and auth config are the worktree's own, not the
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
partway through moves the shell without moving it, so `preview_start` reads the main
checkout's `launch.json` and reports a conflict on :5173 that has nothing to do with the
branch. There is nothing to fix in the repo when that happens, and deleting the main
checkout's file only breaks the preview there too. Start the session in the worktree if
you want the preview tool, and otherwise run `pnpm dev` and drive the printed URL directly.

To point the API suites at a worktree, pass both origins: `API_URL` is the Worker,
`APP_URL` is the SPA origin the tests send as `Origin`:

```bash
API_URL=http://localhost:8817 APP_URL=http://localhost:5217 \
  pnpm --filter @unbent/api exec vitest run test/isolation.test.ts
```

### The Android emulator is the user's: never launch it yourself

**Do not start an emulator.** `pnpm android:build` builds, installs and launches the debug
app; `pnpm android` launches what is already installed. Both boot an AVD only if none is
running, and that fallback is for a human at a keyboard, not for you. If `adb devices` is
empty, **stop and ask the user to start it** from Android Studio's Device Manager or by
running those scripts in their own terminal.

An emulator launched from an agent's shell has no macOS GUI session. It looks fine (it
renders, it boots, `adb` input works, screenshots come back), so it is easy to believe it
is healthy. But its window silently discards every real mouse click, logging
`skipping QEventPoint ... : no target window`. The user is left with an emulator that
ignores them while you report success from `adb`. If you find that line in the log, the
emulator was started wrong; it cannot be fixed from here, only relaunched by the user.

The scripts pass `-no-snapshot-save` deliberately, and the flag is load-bearing in both
directions: it *loads* the saved `default_boot` snapshot, which is where the emulator's
signed-in session lives, and does not write over it on exit. Hand-rolling the launch
inverts both halves. `-no-snapshot-load` cold-boots to a signed-out app, and without
`-no-snapshot-save` the emulator then overwrites `default_boot` on quit with that
signed-out state. That trades a working, signed-in emulator for one that has to be set up
again, and there is nothing to roll back to afterwards.

The AVD is `Pixel_9_API_36` (`AVD_NAME` overrides it). Take it from the scripts rather than
inferring it from what is installed or when files were last touched.

Two builds sit side by side on the device. The **orange** icon is
`com.makerocketgonow.unbent.debug`; the **green** one is `com.makerocketgonow.unbent`, the release build,
which is signed into **production**. Drive the debug one. Never tap through the release app.
A stray tap there writes to the user's real notes.

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
stores an instance per install and it is often `https://unbent.app`, the user's real
notes. App settings shows the address (the site's Settings → App settings inside the app,
or a long-press on the launcher icon) and so does the sign-in screen's footer. Prefer a
local instance for anything that writes.

`pnpm seed:demo` creates `demo@example.com` on this checkout's dev server and fills it with
`packages/seed/`: ten presentable notes, five notebooks with every kind of custom field and
invented records in each, receipts with PDF and image scans whose text is searchable, the
cases that have broken a layout before, a few notes in the trash, and three hundred
generated notes for volume. Load it before trying a change to fields, tables, search or
the list, rather than making notes by hand. It is idempotent, so re-running updates rather
than duplicates; `--reset` clears the account's notes first, `--small` loads only the ten
the store screenshots are of, and `--url` aims it somewhere else on localhost. It refuses any host that is not loopback, because it signs up a password
written down in the script. Sign-up works because `pnpm dev` passes
`ALLOW_TEST_CREDENTIALS=1` to the Worker: local only, see `passwordEnabled` in
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
`uiautomator dump` returns empty while the app is mid-animation or busy: let it settle
rather than treating the empty file as a missing element.

### The iOS simulator: ask before booting, and know which instance it is on

`apps/ios` is the site in a `WKWebView`, the Android app's shape; `docs/ios.md`
says how it is built. `pnpm ios:build` builds, installs and launches the debug build and
`pnpm ios` launches what is installed. Both boot a simulator only when none is running, and
that fallback is for a person. If `xcrun simctl list devices booted` is empty, **ask
before booting one**, and say which you would boot. A simulator is less fragile than the
Android emulator (one booted from a shell works) but it is still the user's machine and
their screen.

The two builds sit side by side here too. The **amber** icon is the debug build,
`com.makerocketgonow.unbent.debug`; the **green** one is the release build. Drive the debug
one, and **check which instance it is on before creating anything**: it opens
`https://unbent.app` until told otherwise, which is the user's real notes. The sign-in
screen's footer and App settings both show the address. A simulator shares the Mac's
loopback, so a local instance is plain `http://localhost:<port>` with nothing to forward.

**Read the port again every time a server is started.** A worktree's pair moves when
something else is on it, and while this checkout's server is stopped another session's can
take the pair it had. An app left pointed at the old port is then talking to someone else's
instance: it happened while the first version of this app was being tested, with the app
signing itself out because that server did not know its session. `node scripts/ports.mjs`,
then App settings.

The service worker only runs from the built site: `pnpm build`, then point the app at the
Worker's port (`API_PORT`), not Vite's. Stopping the dev server is how to take the
connection away from an app on localhost; the app should relaunch into the note list.

Things that cost time once:

- **Sign in with the seed's password, not a code, if you want the password to keep
  working.** `seed:demo` makes its account with a password and an unverified address.
  Signing in to it with an emailed code verifies the address, and the password set before
  that stops working: the account's credential row and its earlier sessions are gone
  afterwards. From then on the account only signs in by code, and `seed:demo` cannot sign
  in to it at all.
- **Typing through a simulator tool counts as a hardware keyboard**, so iOS keeps the
  on-screen one down and shows only the bar above it. What the keyboard does to the layout
  (whether the editor's toolbar sits on the keys) has to be looked at in the Simulator
  window with I/O ▸ Keyboard ▸ Connect Hardware Keyboard off, or on a phone. Say so rather
  than reporting it checked.
- **A screenshot taken straight after a tap can be the frame before it.** Wait a moment,
  and prefer `xcrun simctl io booted screenshot <file>`.
- **The page's errors go to the unified log** in debug builds:
  `xcrun simctl spawn booted log stream --predicate 'process == "Unbent"'`. The web view is
  also inspectable from Safari's Develop menu.
- **A share is three processes, and only one of them is yours to watch.** The extension
  stages and sends one request; the system's uploader sends it; the app is launched in
  the background with the answer and sends the files. The Worker's log shows the `POST`
  then each `PUT`, and the capture's directory
  (`xcrun simctl get_app_container booted <bundle id> groups`, then `shares/`) is empty
  once it has finished. `xcrun simctl addmedia booted <file>` puts a photo in Photos to
  share. A tap injected by a tool does not open a notification in Notification Center;
  say so rather than reporting the tap checked.
- **The instance pref is in the App Group's defaults, not the app's.** `simctl spawn …
  defaults write` makes a domain nothing reads. Use App settings, or edit
  `Library/Preferences/<group>.plist` in the group's container with the app terminated,
  then `xcrun simctl spawn booted killall cfprefsd`.
- **`Config/Info.plist` is preprocessed.** A `//` in it is a comment and an apostrophe is
  an unfinished character; either breaks the build with an error about neither.
- **Anything `deinit` touches must already exist.** A lazy property first read there is
  built by an object that is being freed, and one holding a weak reference to it ends the
  app. Signing out crashed this way until the export streams were made in `init`.

### Three keys sign this app, and Google has to know all of them

Debug builds use the local debug keystore, uploads are signed with the release key in
`~/.config/unbent`, and **Play re-signs every bundle with its own App Signing key**, so
what users install is signed by a certificate that never existed on this machine.

Anything keyed on a signing certificate therefore needs the Play key registered too, not
just the upload key:

- **The `ANDROID_ASSET_LINKS` secret on the Worker**, which is what the instance serves at
  `/.well-known/assetlinks.json`: SHA-256, or App Links open in a browser instead of the
  app, and passkeys stop being offered. It is a per-deployment secret rather than a file,
  because a fork's instance must not vouch for this repository's app; put it on production
  with `wrangler secret put`, and the `ANDROID_ASSET_LINKS` repository secret carries it to
  the dev instance and previews.
- **The Android OAuth client**, in the Google Cloud console: SHA-1. When it is missing,
  Google refuses to issue an ID token and Credential Manager reports `NO_CREDENTIAL`,
  which is indistinguishable from a phone with no Google account. Sign-in appears broken
  only in the store build; every local release build works, because the upload key *is*
  registered.

Both fingerprints come from the app's App signing page in Play Console: search the console
for "app signing" rather than following a menu path, which has moved more than once. Take
them from the **Classical key** column; the post-quantum one beside it is a beta that
neither the OAuth client nor Digital Asset Links accepts. Registering the upload key alone
is the trap: it makes every build you can test locally work.

### Shipping to Play

Pushes to `main` build a signed bundle and upload it to the closed testing track as a
**draft**: it appears in Play Console and passes Play's checks, but nobody receives it
until a person promotes it. Making testers get it automatically is a one-word change
(`status: completed` in `.github/workflows/android.yml`).

Never build a bundle by hand for Play. A local build gets `versionCode = 1`, which Play
rejects as a duplicate; CI takes the run number, which is unique and always rising.

The publish needs `PLAY_SERVICE_ACCOUNT_JSON` alongside the keystore secrets, and skips
cleanly without it. Play also requires **one bundle uploaded by hand** before the API will
accept any: a brand new app or a renamed `applicationId` has to be primed that way once.

## Verifying

Verify UI changes in the browser and show the result: don't ask the user to check
manually. Screenshot the change, and confirm computed styles when the point of the change is
visual. Test both breakpoints when layout is involved.

`pnpm --filter @unbent/web test` and `npx tsc --noEmit` both need to pass. Don't mutate the
user's real data to test a control; if you do it by accident, put it back and say so.

`apps/android` is outside the pnpm workspace: `pnpm -r` silently skips it, so nothing above
verifies it. It is checked with `cd apps/android && ./gradlew test`, which needs no device.
`apps/ios` is outside it too: `swift test --package-path apps/ios/Packages/UnbentCore` runs
its unit tests on the Mac with no simulator, and `xcodebuild -project
apps/ios/Unbent.xcodeproj -scheme Unbent -destination 'generic/platform=iOS Simulator'
build` proves the app and its Share Extension compile without booting one.
The app is the site in a WebView, so almost every UI change belongs in `apps/web` and
reaches the phone on deploy. Check it at phone width and inside the app: Back, the system
bars and the keyboard are the app's, not the browser's. What stays native is the sign-in
screen, the share sheet and App settings, and the UI rules in this file apply to those
Compose screens, and to the iOS app's SwiftUI ones in `apps/ios/Packages/UnbentUI`, as much
as to the site.

## The offline shell, and the local copy of the library

The app opens with no connection and works: a service worker (`apps/web/src/sw/sw.ts`) keeps
the built app on the device, and the account's library (notes, notebooks, tags, the rows for
its files) lives in a SQLite file in the browser's origin-private file system
(`apps/web/src/store/`), kept current by the change feed and written to first. A few rules
hold it together, and most are easy to break from code that never mentions it.

**Every read a view makes comes from the local copy.** `queries.ts` keeps its keys and
shapes; each query function derives its answer from the four collections (`store/derive.ts`,
which mirrors the server's filters and sorts, test for test), and `installLibraryQueries`
re-runs the queries when a collection changes. The instance's config and a note's history
are the reads that still go to the server, and search while
there is a connection (see the search index, below); a new read of notes, notebooks, tags or
files belongs in `derive.ts` with a case in its test, never in a request. A device whose
browser has no file system to keep the copy in (`PersistenceUnavailableError`) falls back to
the requests, which is the app as it was: nothing offline, nothing kept.

**Every note write goes through `store/actions.ts`,** never `api.x` from a component: the
change lands on the local copy at once and goes to the server from a durable outbox
(`@tanstack/offline-transactions`), which replays in order, one entry at a time, with a
growing wait. Two rules keep the queue from sticking, each with a test: every answer the
server would give again (a 4xx other than a lapsed session, a timeout or a rate limit, a
refused precondition) is a `NonRetriableError` that ends its entry, and a `saveNote` whose
note has a later entry in the queue does nothing, since each save carries the whole draft.
Two 402s are kept rather than ended, because the answer changes when the person acts and
ending the entry would roll back what they typed: a lapsed plan's (`plan-refused.ts`) and
a store past its room's (`STORAGE_FULL` with `of: 'notes'`, `store-full.ts`). While
either waits at the head of the queue the deletes go to the server round it
(`roundTheQueue`), and the one that ends a refusal (a checkout, a purge) sends the kept
entry again at once.
Only the tab holding the account's leader lock replays (`store/leader.ts`); another tab
waits in the lock's queue and leads the moment the holder goes, rather than staying a
follower until it reloads, as the outbox library's own one-shot election left it. A tab that does
not hold the library sends its writes to the tab that does, by name over the account's
channel (`forwardable` in `actions.ts`, `store/library-serve.ts`), so they land in that
outbox and are as durable as the holder's own. A file added to a note goes the same way (`uploadFile`): with a connection and
nothing of the note's waiting it is the request it always was, and otherwise its bytes go to
the account's `pending` shelf, its row is made at once and marked `pending`, and its upload
is an entry in the same outbox, behind the note's own. The upload names its file's id
(`X-Attachment-Id`), so a replay finds the file rather than storing `scan-2.pdf`; a direct
upload carries the same id its queued retry will, since its answer can be lost too; a
refused session, a timeout or a rate limit keeps the entry, because the bytes exist nowhere
else; any other 4xx ends it and leaves a notice the attachments panel shows. Putting a
version back from a note's history (`restoreRevision`), and clearing that history
(`clearHistory`), are requests too, and wait for the note's own queued writes first: history
is the server's, and the server keeps what a restore replaces only if it has it. Notebook,
tag and field management stay direct calls that need a connection: they are settings-page
actions with rules the server decides, and the feed delivers what they did to every device.

**A save is the draft and the copy it came from.** Its precondition is that copy's date
(`ifUpdatedAt`, MAK-113); the refusal comes back from the outbox, through `outbox.conflicts`,
and the workspace puts it to the person as before. A draft that already holds every change
the other device made goes again against the newer copy (`holdsTheirChanges`); "Keep mine"
diffs against the copy the draft came from and preconditions on theirs (`against`). A save's
base must be the row as the server last had it, not the optimistic one (`syncedRow` in
`actions.ts`) or a pending write of our own reads as a change of theirs.

**The feed engine is pure and the cursor lives beside the rows.** `store/feed.ts` is given a
way to fetch, a cursor store and the collections' sync controls; it walks the snapshot when
there is no cursor, follows the feed page by page after, and on `reset` empties everything
and walks again. The position is a fifth, local-only collection in the same file, written
after each page's rows have committed: during the walk it is the first page's `seq` and the
page to resume from, so a copy cut short by a closed tab continues where it stopped (an
archive on a phone is minutes of pages) and a page cut short is applied again (every apply
is an upsert); once the walk is whole it is that `seq` alone, and the feed is followed from
it, so anything written during the walk is replayed. Collections are ready as soon as
persistence has restored them, not after the first pull. Pulls are event-driven (open, tab
shown, connection back, socket nudge, after a replayed write), never a timer, with one
exception: a copy that is not whole and whose pull failed is tried again on a doubling
wait (`retry` in `feed.ts`), since no event comes to a tab left open on an empty list. Each
page of the feed and the snapshot has a timeout (`fetchJson` in `library.ts`): a pull that
never settles holds every later one behind it.

**A note the copy does not hold while no snapshot has been taken is asked of the server, or
reads as not available, never as missing.** `noteQuery` asks the server while there is a
connection, since the copy can take minutes on a phone and a followed link should open, and
throws `OfflineError` without one; a 404 means the id is not a note.

**A row made here may name what the server has not.** A note filed into a notebook that
does not exist yet, or tagged with a tag nobody has used, carries `notebookName` and
`tagNames` until the feed brings the ids (`LocalNote`); the derivations read those first.

**What the worker keeps is one read: the instance's config.** `classify` in `src/sw/routes.ts`
names it, matched by the whole shape of the path, never by prefix; `/api/changes` must never
be answered from a cache, since a cached page replayed over a cursor is rows applied twice or
never. File bytes are kept only when someone looks at them: an `<img>`, or a fetch carrying
`X-Unbent-View: 1`, which the PDF viewer sends. The indexer and export read every file through
the same addresses and must not send that header; a new viewer must. That cache has a budget
(`sw/budget.ts`: 500 MB, 500 files, a month, oldest-opened first), kept by an index that is
one more entry in the cache, so emptying the cache takes it too.

**File bytes someone chose, or that exist nowhere else, live under the account, not in the
cache.** `store/files.ts` is an OPFS directory named for the account with two shelves:
`kept`, the files of the notebooks this device keeps offline (`store/keep.ts`), and
`pending`, files added here that have not uploaded. A directory per note and the file under
its own name, so the worker answers a file's address from the shelf with no index, and it
does, before the cache or the network, for every read but a page load (`shelved` in
`sw/routes.ts`): the worker cannot know the stored type the server picks a safe one from,
so a navigation is never answered from a shelf. What the `kept` shelf should hold is a pure
function of the library and the kept list (`plan`); the keeper stands down while the library
is not whole (a walk has not finished, which is not the same as the last pull failing),
since a pass during the first copy would drop what it would fetch again, and
runs only in the tab that holds the outbox. It fetches through `request()` and unmarked, so
a kept notebook never fills the cache of opened files. A list of kept notebooks that cannot
be read is unknown, never empty: a pass over an empty list removes the whole shelf. The list
is read from the device at the start of every pass, because the tab that fetches is rarely
the one Keep offline was pressed in; a `BroadcastChannel` only makes that prompt. A file that is on neither shelf nor
in the cache says "Not available offline" where its preview would be (`offline-file.ts`):
one phrase, in the note's body, never a spinner and never in the head.

**Evidence decides whether the app is offline, never a hint** (`connectivity.ts`). The app
is offline while the server is out of reach: a check of `/api/health` with a timeout got no
answer, or the browser fired `offline` and nothing has answered since. It is online the
moment the server answers anything: a check, or any answer to a request the API client
made that the worker did not serve from a cache or a shelf (`confirmReachable`, called by
`request()`; the worker marks what it served, `X-Unbent-Served`). `navigator.onLine` only
starts a check, and is never allowed to veto one: while it was a veto, a laptop whose
browser was wrong about its network sat on the banner for a day with every request
succeeding, refusing saves (2026-10-13). A failed request, a socket that dropped and a save
that timed out still only ask for a check (`recheck`): letting failures flip the state was
tried first, and every new kind of failure became a new way to flicker. Settings → Offline
says what decided the current answer and when. Nothing else decides, not the outbox,
whose online detector is backed by the same store.

**API calls from the page go through `request()` in `notes-api.ts`,** which is where those
checks are asked for: a fetch with no answer becomes an `OfflineError`, which the outbox
treats as retriable. Code that retries on a network error must recognise `OfflineError` as
one (`transient` in `export-archive.ts`): it is an `ApiError` with status 0, not the
`TypeError` fetch throws. Two deliberate exceptions, and nothing else should join them:

- `apiFetch` in `attachment-text.ts`: the indexer. It runs inside the import Web Worker,
  where the page's connectivity store does not exist, and it reports its own failures to
  the page. (It must also never send `X-Unbent-View`; neither must export.)
- `device-api.ts`: Better Auth's device and one-time-token endpoints under `/api/auth/`,
  which the service worker never touches and whose screens report their own failures.

**What this device keeps of an account goes when the account changes hands, and the
outbox goes only then.** `clearOfflineCaches()` runs on sign-out, on a refused session, on
account deletion and when a different person signs in. The worker's caches go every time;
they are keyed by address and cheap to refill. The local store, its search index, the outbox and the
account's files directory (`store/wipe.ts`) are keyed by account, and the outbox holds
writes the server has not heard of (the files directory holds the bytes of its uploads) so they go only when the account has changed hands for good: sign-out and account
deletion remove every account's, a different person signing in removes every account's
but their own, and a refused session (someone who edited offline for longer than their
sign-in lasted) closes them and keeps them, so their sign-in reopens the store and replays
what waited. Sign-out first waits a few seconds for the outbox to drain. The names are in
`store/names.ts` and nowhere else. A new way for the account on a device to change hands
has to call it too, and say which of the three it is.

**One tab holds an account's library on a device; the others are its clients.** A Web
Lock named for the account (`store/library-lock.ts`, `libraryLockName`) says whose. A tab
that finds it held opens nothing of its own: it joins the account's `BroadcastChannel`
(`store/library-channel.ts`), is sent the holder's four collections as rows and every
change to them after, and derives what it draws from those rows itself, as the holder
does from its collections (`store/client-library.ts`); the feed's state, the outbox's
status and the keeper's are mirrored the same way, so every hook and query reads a client
as it reads the holder and nothing in the chrome tells the tabs apart. What crosses as a
call is what only the holder can do (a write, a search of its index, keeping a notebook,
a conflict resolved) and a call's failure comes back as the class it was (`carry`,
`revive`). Settings → Offline still says which tab holds the file, with Open here beside
it: that takes the lock with `steal`, the tab that held it closes its library and attaches
as a client. A client waits in the lock's queue and opens the library on its own the
moment the holder's page goes or closes its library, keeping its rows and holding its
calls meanwhile, so closing the holding tab needs no press; a call in hand when the
library moves to this tab is made again here (`LibraryMovedError`). A new thing a client
needs of the holder is a message in the channel's one list, or a name the holder's
dispatcher runs. There are two channels, and no third: the account's, which every tab
of the account hears, and one per client for what is that client's alone: the rows
above all, since a browser decodes a message in every listening tab before any can drop
it, and the library is tens of megabytes. A browser without `BroadcastChannel` reads the
server as every second tab did before 2026-10-13, under `LibraryElsewhereError`.

This replaced every tab holding the library at once: each its own connection to the
store's file, taking turns on its one access handle; each a connection to the outbox's
database; one the leader of each collection, with the others' writes going through it by
message; one the outbox's leader. Four coordinators that knew nothing of each other made
states nobody designed (a follower left behind by a closed leader, an open waiting for
good on a handle a frozen tab held, a wipe blocked on a connection in a tab on the
sign-in screen), and forty commits in four days bounded and queued around them
(2026-10-07 to 10-10). The libraries' cross-tab paths are still underneath, and untested,
since nothing exercises them now; do not build on them. The owner could be a
SharedWorker on the desktop later; the protocol does not care which tab or worker
answers, and Android Chrome has no SharedWorker, so the holding tab is the owner for now.

Three things keep a wipe from wedging the next sign-in, and a new way to hold or wipe the
library has to keep them. The wipe tells the other tabs, over the channel in
`store/wipe.ts` (`installLibraryCloser`), all but a tab holding the account a sign-in's
wipe keeps (which keeps its library), and `recordSession` closes the library in any tab
whose session the server has refused, so a tab left on the sign-in screen holds nothing;
a tab told to close then asks the server who is signed in, so it does not open the old
account again from the session it remembers. The outbox closes its connection on
`versionchange`, which is how IndexedDB asks, and the library closes with it. And
`acquireLibrary` answers its caller within `LIBRARY_OPEN_TIMEOUT_MS` whatever the open is
doing (a refusal past the bound, reported, and the page reads the server) so a wedge is
a page with no local copy rather than a dead app. A tab that holds the library and is
wedged on something it waits for, or a window someone forgot, is what Open here in another
tab is for: the lock is taken from it and its library closes. A tab the browser has frozen
is not: its worker cannot hand the store's file over, so the taking tab's open waits out
`LIBRARY_OPEN_TIMEOUT_MS` and reads the server until the frozen tab is closed or resumed,
when the open finishes on its own. A client that was served once and whose holder then
froze is in the same place: its hello goes unanswered until the holder resumes or goes,
and meanwhile it reads the rows it has and holds its writes. A tab that has never been
served does not wait: three hellos in six seconds with nothing heard from any holder
(no `serving`, no rows, no `opening`) is a tab that holds the lock and runs nothing for
this account, frozen or on a build from before the channel, and the client takes the
library over (`UNANSWERED_HELLOS` in `client-library.ts`), under the deadline its attach
was given, so beside a frozen tab whose worker still holds the file it is refused at the
same twenty seconds as before and no later; a takeover by a tab that was served once is
a new ask and gets a bound of its own. A tab granted the lock says `opening` on the
channel before its open and in answer to every hello until it serves, for exactly this
reason: a hand-off on a phone takes seconds, and a client waiting on one must not read
that as silence. Before this, every reload with an older tab left open after a deploy
was twenty seconds of nothing and then the server (2026-10-14).

Every open and close of the library is a step on one queue in `library.ts` (`enqueue`),
run only after every step before it has settled and never abandoned. A new way to open or
close the library is a new step there, never a call beside the queue, and what is bounded
is what a caller waits, never the step (a wipe's wait is `CLOSE_WAIT_MS` in
`store/wipe.ts`). A close that takes a stuck open's entry halts its engine, socket and
listeners at once (`halt` in `open`), so an open a sign-out moved on past pulls nothing
into a file the account no longer owns; the store and the outbox stay the step's.

**Offline is not `readOnly`, and it no longer locks.** The trash's `readOnly` turns the
autosave off and drops the draft. Offline, the note is as editable as ever and the head
still says "Saved": one word, because beside a title on a phone the head has room for
about that, and a sentence there shrank the title twice. What the server has not heard of
is said elsewhere: a cloud glyph beside the word while *this* note has an entry waiting in
the outbox (`NotSyncedMark`, "Not synced yet" on hover or tap), the banner for the device
being offline, and a line in the strip when writes have waited online for a few seconds
(`SyncingLine`). What fades is what needs the server now (Auto-fill, the ⋯ menu,
and copying, moving or deleting a file) and a new control that needs the server should
follow `offline`, not lock the note. Adding a file does not fade: it is queued, and its row
in the attachments panel says "Waiting to upload" until it has gone, and Delete on that row
takes the file back without the server ever hearing of it (`cancelUpload`).

**Search has two engines and one key.** With a connection the server answers, because it
holds every file's text. Without one, `searchQuery` asks the device's index
(`store/search-index.ts`): four FTS5 tables in a SQLite file of its own beside the
library's (`unbent-<account>.search.sqlite`), declared as the server declares its own, with
`toFtsQuery`, the tokenizer and the title weighting shared from `@unbent/shared` so the two
cannot drift. The index holds ids and text; `store/search-local.ts` answers the joins and
the filters from the library's rows with `derive.ts`'s own predicate, so nothing about a
note's notebook or tags is copied into the index to go stale. It is a file of its own
because the library's connection belongs to the persistence layer's transaction queue, and
a search on it would sit in front of every save. Everything in it is derived, so there are
no migrations: bump `SEARCH_INDEX_VERSION` and it is built again.

`SearchSync` keeps it in step, in passes, in the tab that holds the outbox and only once
the library is whole: the keeper's rules, for the keeper's reasons. The first pass
compares every note by stamp; after that the library names the notes that changed, and a
new way for a note to change that does not go through the collections will not be indexed.
Files' text is never synced wholesale: `textPlan` wants it for notebooks kept offline and
the last `RECENT_NOTES` notes opened here (newest first, up to `RECENT_TEXT_LIMIT`
characters between them, a file let go for room keeping an entry that remembers its length
so the plan does not fetch it again) and fetches it by file id from
`POST /api/attachments/texts`, which cuts its answer on bytes. An answer from the device
carries what it covered (`LocalCoverage`), and the line under the results
(`SearchCoverage`) says so; a new place that shows search results offline must show it
too. The index tests run on the same `wa-sqlite.wasm` the browser loads
(`store/test-search-db.ts`), and `pnpm gate:offline` checks the whole path with the
network cut.

**A deploy's worker takes charge at once, and no page is ever moved onto it.** A page load
is answered from the network first and from the cached shell only when the network does
not answer (`sw.ts`), so a reload is always the newest build. Each build's shell is in a
cache named for the build (`shellCacheName`), and the previous build's cache outlives its
worker, so a tab still running the previous build keeps finding its chunks after the new
worker has taken charge; only a tab that outlives two deploys without a reload loses them,
and `recoverFromMissingChunks` reloads it once when a chunk is gone. The one thing the
page says is that a reload would bring a newer build (`UpdateSnackbar`), and only when the
worker's commit differs from the page's (`BUILD` in `sw.ts`). The rules this replaced (a
change of section, five minutes away, nothing touched since the load, at once on dev and
previews) each answered a reload that drew the old build or lost someone's place, and
between them still moved every other tab onto a worker that had deleted their chunks.
`pnpm gate:offline` checks that a removed chunk is a 404 and that the shell is kept under
the build's name; a deploy while a tab is open is checked by hand (a second build, then
`update()` from the page).

**Never delete `sw.js`.** The Worker answers an unknown path with `index.html`, so a deleted
worker script is a 200 the browser cannot install, and the old worker stays in charge on
every device indefinitely. To retire the worker, ship one that unregisters itself and
empties its caches.

**Testing it.** Component tests feed an in-memory library (`store/test-library.ts`), under
which the actions fall back to the mocked API; the outbox and the file system are checked in
a real browser. Vite's dev server does not run the worker: build the web app and load the
Worker's own port, which serves `apps/web/dist` beside the API: this checkout's `API_PORT`,
not Vite's. The Browser pane cannot register a service worker at all, so drive a headless
Chrome over the DevTools protocol instead (the gate scripts from MAK-140's spike are the
shape). Take a connection away with `Network.emulateNetworkConditions` on the page *and* on
every service-worker target, attaching one session per target and reusing it: emulation is
per session, and a second attach leaves the first one's conditions in force. `pnpm gate:offline`
(`scripts/offline-gate.mjs`) is that, kept: with `pnpm dev` up, the demo account seeded and
the web app built, it installs the worker, cuts the network on the page and the worker, and
checks that a page load with the worker's caches emptied still loads and fills them
again, that a file not on the device says so, that the worker, its caches and the library
survive, that an opened file draws again, that a file added offline uploads on
reconnect, and that search answers from the device: a note by its body, a PDF's text only
once its notebook is kept, and the server's answer in place on reconnect. Run it before asking anyone to test offline behaviour by hand. On a phone,
**never clear site data between attempts**: that removes the worker, and the app cannot
open offline again until Settings → Offline says it is on the device. The real check
is still airplane mode on the phone, with `adb reverse --remove-all` as well when the app
points at a local instance: airplane mode alone does not cut the adb tunnel. The persistence
worker applied rows at about 25 a second on the emulator (1,500 notes in 70 s) against well
under a second on a desktop, so an archive takes minutes to settle on a phone; measure on a
real device before tuning it.

## The local database is disposable, but ask

Wiping local notes during development is fine and has been offered explicitly. **Ask first
every time**: a local database may hold a copy the user is in the middle of looking at, and
the state may have changed since the last conversation. Production is never wiped or
re-imported; the account on unbent.app is the user's real archive, and what is in it stays. "The database" is D1 and the note
stores under `.wrangler/state/v3/do/` together; `db:reset` and `reset:local` clear both.

That corpus is ~3 GB and ~13K notes, mostly PDFs: this is a paperless-office use case.
Performance assumptions should hold at that scale, not at the scale of a dev database with
90 notes.

## The per-account note store

Every account's notes live in one SQLite-backed Durable Object per user: `UserStore` in
`apps/api/src/store/`, reached through `reposFor` in `lib/repos.ts`. D1 keeps the control
plane: Better Auth's tables, OAuth and MCP clients, upload grants, and the account
directory. The object is the repository: `NotesStore` and `AttachmentsStore` hold the SQL,
with no `user_id` anywhere, because the database is the user; `lib/notes-repo.ts` and
`lib/attachments-repo.ts` are facades over the stub, one RPC call per method, keeping the
signatures every route and tool was written against. The decision and its reasons are in
MAK-128; the short version is that the sync change feed and note history are storage
features, and building them on D1 and then porting would be paying twice. "Where your notes
live" in `docs/architecture.md` is the user-facing account of the same thing.

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
4. **The change feed is per user with a sequence cursor**, never global. Built: see
   [The change feed](#the-change-feed) below.
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
  wipes anything, and a row is dropped only once the user row is gone too, its late writes
  are over (`LATE_WRITES_MS`: a session open at the deletion writes on its cached cookie
  for a while after it) and nothing is left under its prefix in R2. Keep it that way: the
  row is the only thing that names a deleted account's prefix. The local test purge
  (`purge-fixtures`) drops its actors' rows at once, since nothing writes as them once
  the suites are over, but clears their files first all the same.
- **Subrequests are the budget inside one invocation.** Fifty on Free, and every D1 query
  and every store call counts. The sweep walks twenty accounts a run at two store calls
  each; a dump is one store call per eight-megabyte slice (`dumpSlice`), so one for a
  small account and about five for an archive; the daily dumps at :47 count every call
  and stop an account's dump rather than pass fifty (`lib/backups.ts`); anything new that
  loops over accounts or pages D1 needs the same shape. CPU is a budget too (ten
  milliseconds an invocation on Free, thirty seconds inside an object) so work over a big
  result, like turning a dump page into SQL text, is done in the object and forwarded.
  unbent.app itself is on Workers Paid (ten thousand subrequests, thirty seconds of CPU a
  cron run), but a fork deploys this same Worker on Free, so anything every instance runs
  keeps to Free's numbers. Only a feature an operator has to switch on may be sized for
  Paid, and it says so where it is switched on.
- **Nothing periodic may scan a table.** The sweep reads `usage()` (the one `note_counts`
  row and the database size), never `stats()`, which counts every table and is the
  operator's. An hourly `stats()` on an archive-sized account would read every row of it
  twenty-four times a day. The rows-read test bounds `usage` at a handful. The daily
  dumps are the one periodic read of whole stores, by design, and only of accounts whose
  feed moved since their last dump or whose dump is a week old: an unchanged account costs
  `dumpBegin` two `_meta` rows, and a dump reads each row once, which the rows-read test
  pins.
- **A new D1 index changes other statements' plans, not only the one it was added for.**
  The planner has no statistics, so an index is taken by every statement on its table
  that can use its first column: at the cutover, a plain `user_id` index added for the
  copy turned a file lookup by note into a read of every file of the account. Before
  adding one, `EXPLAIN QUERY PLAN` the table's other statements on a SQLite built from
  `apps/api/migrations/` (`migrations.test.ts` shows how), and prefer an expression
  index, which only its own spelling can use.
- **Local state is D1 *and* `do/`.** The reset scripts clear both; clearing one by hand
  leaves ghost objects. `worktree:setup` copies both.
- **Nothing but the sweep deletes a file's object, and nothing deletes one the store has
  not tombstoned.** Every store method that deletes an attachment row writes the file's
  key to `deleted_blobs` (0005, `store/deleted-blobs.ts`) in the same transaction, and
  the hourly sweep (`lib/sweep.ts`) deletes from R2 what has sat there thirty-five days,
  five more than a restore can reach, so a store wound back finds its files. The keys
  the purge methods return are for the count, not for the caller to delete; a route that
  called `BLOBS.delete` on them would take the thirty-five days back. Account deletion
  is the one path that deletes objects by prefix: at once, and again from the sweep
  before the account's row is dropped, for files a still-open session uploaded after the
  deletion. A new way to delete a row has to tombstone; a new way to record one has to
  `revive` its key, as `record` does, since a replayed upload can bring a tombstoned key
  back as a live file.

- **A store is whole, wiped or loading, and answers only when whole.** `POST
  /api/admin/store/load` empties an object and fills it from a dump in pages, with a
  marker in the object's key-value storage (`LOADING_KEY`) from the `deleteAll` to the
  last check; while it is there `ready()` throws `StoreLoading`, which is `retryable`, so
  a request gets the 503 the Worker already answers for a passing unavailability and the
  sweep and the daily dumps defer. Only `loadFinish` clears it, after the owner and
  schema checks and the migration, and only `wipe` and a point-in-time restore take it
  otherwise. A new data method must go through `ready()`, or it answers from a
  half-loaded store. The statement scanner and the rules for which statements run are
  in `store/load.ts`, pure and unit-tested; a dump holds `CREATE` and `INSERT` and
  nothing else runs.

### Note history

`note_revisions` (`0003-revisions`, `0004-revision-props`, `store/revisions.ts`) holds the
note as it stood before a write changed it: its title and body, and since MAK-170 its
notebook, tags and field values (`props`, one JSON column); "Undoing an edit" in
`docs/history-and-trash.md` is the user-facing account. What to know before changing it:

- **`NotesStore.update`, `updateMany` and `restoreRevision` are the only writes that keep
  a copy**, in the transaction that makes the change. A new method that changes a note's
  text, fields, tags or notebook has to decide, and say in its comment, why it does or
  does not. `appendToBody` and import do not, and neither does what a notebook's or a
  tag's own management does to the notes under it, each for a reason given on `update`.
- **Who is writing decides how often.** A person's edits keep one copy per
  `REVISION_WINDOW_MS`, whatever part of the note they change. The MCP tools pass
  `by: 'assistant'`, which keeps a copy even inside the window unless what is being
  replaced is the output of an assistant's write that already left one (`through` on the
  row is how that is told). `by` is not in the HTTP schema, so a browser cannot claim it
  and a new MCP tool that writes a note must pass it.
- **A copy with no `props` is "not recorded", never "had none".** Every copy kept before
  0004 is one. It shows no fields and a restore leaves the note's own alone; code that
  reads `props` must keep that difference.
- **Restore goes by id and never fails over what no longer fits.** `planRestore` is the
  one place that decides what a restore writes and what it skips (a deleted notebook, tag
  or field; a value its field can no longer hold), and `getRevision` answers the same plan
  as `unfit` so the sheet says it before the press. `diffProps` in the web app mirrors its
  rules to draw Changes; change one and change the other.
- **Not in the feed, the export or the local library.** Fifty bodies per note on every
  device is what that would cost. The History sheet reads the server each time it opens.
- **Pruned on the write that adds a copy, for that note only**, no cron. Bounded in the
  rows-read test with the other hot queries. The three numbers (`REVISION_WINDOW_MS`,
  `REVISIONS_KEPT`, `REVISION_MAX_AGE_MS`) live in `@unbent/shared`, because the History
  sheet states them to the person; change them there and nowhere else.
- **Clear history waits for the note's queued writes** (`clearHistory` in
  `store/actions.ts`), like a restore. A save still in the outbox would land after the
  clear and keep a copy of the very text the person was clearing.
- **Revision ids are integers**, the one exception to rule 2. A revision is never exported,
  shared or in the feed, and is only addressed under its note, so a UUID would buy nothing
  and cost one more index row per copy. A new table whose rows can be exported or named
  across accounts does not get the same exception.

### The change feed

Every write to a store records what it touched in the `changes` table (`0002-changes`),
and `GET /api/changes?since=` answers "what changed since N?" from it; the contract is in
`packages/shared/src/feed.ts`, the writer in `store/feed.ts`, the reader on `UserStore`
(`changesSince`, `snapshotPage`). MAK-139 built it; MAK-140's local store is its reader.
Rules that hold it together, each with a test:

- **Record inside the transaction that made the change, after the change.** `Feed.record`
  opens no transaction of its own, so every write method calls it from its `tx()`: the
  single-statement methods gained one for this. The rows are held until the outermost
  `tx()` is about to commit (`Sql.onCommit`) and written then, with the counter once, so
  a write that records from several helpers still costs one counter write, and a write
  that rolls back wrote nothing. `feed-coverage.test.ts` greps the object's methods and calls every write
  once: a method that writes a data row without advancing the counter fails by name, and
  a new method lands in one of its three lists or fails there too.
- **A row for every entity whose rendered shape changed, from the method that knows.**
  A feed note carries its tags and notebook by id only (`tagIds`, `notebookId`), never by
  name, so a tag or notebook rename is one row and a delete one tombstone, and a client
  renders the names from the tags and notebooks it holds; a merge names the notes whose
  ids moved. Field values keep their carried names for the one definition a client
  cannot hold, a deleted notebook's tombstone; see `FeedNote`. A field conversion, deletion or
  cleared option records the notes whose values it rewrote. A notebook is one row except
  a delete, which names the notes it unfiled. A file added or removed records the file
  and its note; text arriving records the file alone. `feed-writes.test.ts` pins each
  method. A tag on an imported archive renamed must never be the archive sent again.
- **The trash is an update; only a purge is a tombstone.** A client keeps its trash.
- **No counts in the feed.** Tagging, filing and trashing a note move a notebook's and a
  tag's counts without recording either, so a count carried on a tag or notebook row
  would be wrong by the next write. A client derives counts from the notes it holds.
- **One row written per change and one per transaction**, by construction (the flush at
  commit), measured and bounded in `feed.test.ts`. No other index on `changes`: each would be a row written per change.
  Pruning (50,000 rows, 90 days) reads nothing until it has something to delete, and
  deletes old rows 500 a write by key range, never by a subquery that scans.
- **A cursor the feed cannot serve gets `reset`, never a partial page.** From another
  epoch than the one the client sends with its cursor (`?epoch=`; a client that follows
  the feed always sends it), past the counter, or before the oldest row kept. The restore
  route changes the epoch (`feedRestored`) once a restore is applied and tells the sockets;
  `POST /api/admin/store/feed-epoch` does it by hand.
- **The push is an optimisation and carries only a number.** `GET /api/changes/socket` is
  forwarded to the object's `fetch`, the one `fetch(` the guard test allows in `store/`
  and the only way a socket reaches an object (it cannot cross RPC). Accepted through the
  hibernation API, so an idle device costs no duration; keep timers and alarms out of the
  object, or it never hibernates. After a write that recorded, `{"seq": N}` goes to every
  socket and nothing else; incoming messages are ignored and pings are answered at the
  edge. A client that never connects a socket is still complete: pull on open, on focus,
  after a write.
- **A page is cut on bytes** (`FEED_PAGE_BYTES`, 4 MB of bodies) and always carries at
  least one note, so it never nears the 32 MiB RPC ceiling; `more` says to call again.
  `changesSince` and `snapshotPage` are bounded in the rows-read test at about nine rows
  per note.
- **Ids may come from the client.** `POST /notes` and a duplicate take an optional UUID
  and answer 200 with the holder of a taken id, so a replayed request makes no second
  note (`createOrFind` / `duplicateOrFind`, which say `existing` beside a plain `Note`;
  `create` itself still refuses a taken id). Nothing else needs a client id yet.

## The plan, and what a lapsed account may do

An instance with the five `PADDLE_*` settings sells a plan (MAK-108; "Selling the plan" in
`docs/billing.md`), and every account on it is on its trial, paid for, comped, or lapsed. A
lapsed account is **read-only**: every write is refused with a 402 except a delete, and
reads, search, export and an assistant's reads keep working. Three things hold that:

- **The rule is global and deny by default.** `requireActivePlan` in
  `lib/plan-middleware.ts` runs in front of every `/api` route, and a request that is
  not a read is refused unless `EXEMPT` there says otherwise, with its reason. A new
  mutating route is read-only for a lapsed account until someone adds it to that list,
  and `plan-middleware.test.ts` reads the app's route table and fails by name on any
  mutating route that is neither exempt nor listed as gated, so a new route has to be
  classified, out loud, in the commit that adds it. The MCP endpoint is one POST for
  every tool, so its write tools check for themselves through `gatedRegistrar`
  (`mcp/plan-gate.ts`), keyed on each tool's `readOnlyHint`.
- **What the account is, is derived.** `planStateOf` works the row out against the
  clock; nothing flips rows on a timer. A comp is set from the operator's page, never
  with a Paddle discount (a 100% discount there still asks for a card) and while it
  runs the webhook changes nothing on its row (`planPatchFor`), since a former
  subscriber who is comped still has the customer id the webhook finds rows by.
- **Bytes are checked where they come in.** Every path that stores or copies a file
  passes a `quota` to `storeAttachment` or `copyAttachments` (lib/quota.ts); the sum it
  is checked against is the store's own (schema 0008), never a read of the files table.
- **The store itself is bounded too** (MAK-234): half a gigabyte plus a tenth of the
  quota, since note bodies, their history and files' text live in the object's SQLite
  and nothing in the quota counts them. The limit travels with the repos (`reposFor`
  requires a source for it), and `UserStore` checks it against `databaseSize`, which
  reads no row, on every write that adds the person's or an assistant's text; deletes
  and purges take none. A new write of outside text takes the limit, and a new
  `reposFor` caller that writes must not pass `noStoreLimit`.

Where billing is off (every fresh checkout, every fork) none of this exists: every
account is active for good, the Plan tab is not drawn, and nothing reads a plan row.

## Rows read are still the budget

The rows a Durable Object's SQLite reads and writes are metered as D1's were. Production
ran on Workers Free until October 2026, and the shared database ran out of its daily reads
twice in one week before the query plans were fixed. It is on Workers Paid now, where the
same rows are a bill rather than a wall, and a fork is on Free until its operator decides
otherwise, so the rule did not move with the plan. A change to a query is judged by the rows it
reads on an archive-sized store, not by whether it returns the right rows. The accounting
is the `[store]` log line the `Sql` seam writes for any statement over two thousand rows,
with the user id and the statement; `POST /api/admin/store/sql` runs `EXPLAIN QUERY PLAN`
against a real account; and the rows-read test at the end of
`apps/store-tests/test/notes-store.test.ts` bounds every hot query on a three-thousand-note
store. A new query belongs in that test.

The planner has no statistics (there is no `sqlite_stat1`) and takes the first column of an
index to be selective. Every notes index leads with `deleted_at`, which matches every live
note, so `+deleted_at` (the unary plus keeps that column's index out of the plan while the
condition still applies) is written wherever an `id IN (…)` run or a tag filter is the
way in, and `+n.notebook_id` beside a tag filter for the same reason. `liveCondition` in
`store/notes-shared.ts` is where it is applied. Measure a new index or a `+` against a tiny
notebook as well as the big case; on the shared database a global index once made a
30-note notebook read 13k rows.

D1 serves the control plane only (the note tables were dropped by migration 0036 after
the cutover) and its reads still count against the same daily total.

Do not run `PRAGMA optimize` or `ANALYZE` on production, whatever the documentation
suggests: not on D1, and not inside an object. Measured on a copy of the archive, the
statistics they write made the image-queue queries two to three times worse, and a full
`ANALYZE` reads about 572k rows on its own. The plans this codebase depends on are pinned
in SQL instead; the read-only SQL route refuses a `PRAGMA` for this reason among others.
