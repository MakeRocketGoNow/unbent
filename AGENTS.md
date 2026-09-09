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

There is no icon library, deliberately — the reasoning is recorded in `icons.tsx`:
this is a handful of icons in a codebase whose other controls are letters (B, I, S, H1),
and a dependency would not draw those anyway.

New icons go in `apps/web/src/components/icons.tsx` and go through the `ToolbarIcon`
wrapper there, which fixes the shared geometry: a 24×24 box, `currentColor` stroke at
width 2, round caps and joins, and `aria-hidden`. Pass it paths, and it will match
everything else. `HeaderIcon` beside it is the same geometry at a larger size, for an icon
that sits alone in a 44px target rather than in a dense row.

**This is a decision about the current scale, not a principle.** We are open to adopting an
icon library if the icon count grows enough to justify it — hand-drawing paths stops being
cheaper than a dependency somewhere around a dozen icons, and a real set also brings
consistent optical sizing and a much wider vocabulary than anyone wants to draw by hand. If
you find yourself drawing several new icons for one feature, or reaching for a glyph that
would be tedious to draw well, say so and propose the switch rather than quietly adding more
paths.

**We are past that line: fifteen icons.** The phone's note list added search, filter, sort,
close, menu, plus, tag and calendar. The first six are a few straight lines each and a
library would not have drawn them better; the last two are not — the tag with its punched
hole and the calendar were drawn by translating Android's own drawables by eye, which is
exactly the work a real icon set exists to save.

**So the next icon should come with the switch, not after it.** Adding a sixteenth by hand
means someone is redrawing a shape that lucide or Material already has, and doing it less
well. `icons.tsx` is the single seam this passes through, so the change is that file and
its callers rather than SVG scattered across the codebase — but it needs asking about
first, as the paragraph above says.

`icons.tsx` is what makes that switch cheap: it is the single seam every icon passes
through, so moving to a library means changing that file, not hunting SVG across the
codebase. Keep new icons going through it for that reason.

Either way, don't add the dependency without asking first.

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
person doesn't re-litigate it or silently undo it. `Topbar.tsx`, `OverflowMenu.tsx` and
`Confirm.tsx` are good examples.

Write them for the reader who is about to change the code. If a line looks arbitrary and
isn't, say why. If something was tried and didn't work, that belongs in the comment.

## Commits

Atomic commits, one logical change each. This has been asked for explicitly and more than
once.

The subject line says what changed **for the user**, in plain language, as a sentence:

> Let the editor's PDF page count expand to show every page.
> Keep the divider under the pointer while dragging
> Show where a dragged file will land.

Not `feat(editor): add PDF expansion`. The body explains what was wrong before, what the
change does, and any non-obvious reasoning — the same "why" standard as the comments.

The user drives commits with a `msg-and-commit` skill, which scopes the message to the
current session's changes rather than the whole dirty tree. It lives in their environment,
not in this repo, so it may not be available to you — if it isn't, follow the same rule by
hand: stage only what this session touched.

Commit when asked. Don't commit or push unprompted.

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

Branch work often happens in a worktree beside the main checkout. **Run
`pnpm worktree:setup` once in a new one**, before anything else. `git worktree add` brings
tracked files and nothing else, so until then the worktree has no `.dev.vars` (the Worker
starts with no `BETTER_AUTH_SECRET` and no OAuth credentials), no dependencies, and no
local database. The setup script copies those across and seeds D1 and R2 from the main
checkout, then prints the ports.

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

### Sample notes, and shooting the app

**Check which instance the app is pointed at before creating anything.** The debug build
stores an instance per install and it is often `https://unbent.app` — the user's real
notes. Settings shows the address, and so does the sign-in screen's footer. Prefer a local
instance for anything that writes.

`pnpm seed:demo` creates `demo@example.com` on this checkout's dev server and fills it with
ten presentable sample notes. It is idempotent, so re-running updates rather than
duplicates; `--reset` clears the account's notes first, and `--url` aims it somewhere else
on localhost. It refuses any host that is not loopback, because it signs up a password
written down in the script. Sign-up works through `ALLOW_TEST_CREDENTIALS=1` in
`.dev.vars` — local only, see `passwordEnabled` in `apps/api/src/auth.ts`.

Point the app at that instance from Settings → Unbent address, or the sign-in screen's
Change. Use `adb reverse tcp:<port> tcp:<port>` and the plain `http://localhost:<port>`;
the dev servers bind loopback, so `10.0.2.2` does not always reach them, and a worktree's
port is not 5173 (`scripts/ports.mjs`).

**Switching the address signs the app out of the instance it was on.** Sessions are stored
per origin and the old one is dropped, so a debug app that was signed into production comes
back signed out and the user has to sign in again. Say so rather than leaving them to find
it.

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

- **`apps/web/public/.well-known/assetlinks.json`** — SHA-256, or App Links open in a
  browser instead of the app, and passkeys stop being offered.
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
The UI rules in this file apply to the Android app's Compose screens as much as to the
web app. The app's editor is the web editor in a WebView, so a change to editing behaviour
belongs in `apps/web` and reaches both.

## The local database is disposable — but ask

Wiping local notes during development is fine and has been offered explicitly. **Ask first
every time**, because the plan is one final import from the real Evernote corpus and the
state may have changed since the last conversation.

That corpus is ~3 GB and ~13K notes, mostly PDFs — this is a paperless-office use case.
Performance assumptions should hold at that scale, not at the scale of a dev database with
90 notes.
