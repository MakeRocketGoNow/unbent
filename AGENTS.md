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

There is no icon library, deliberately — the reasoning is recorded in `EditorToolbar.tsx`:
this is a handful of icons in a codebase whose other controls are letters (B, I, S, H1),
and a dependency would not draw those anyway.

New icons go through the `ToolbarIcon` wrapper in that file, which fixes the shared
geometry: a 24×24 box, `currentColor` stroke at width 2, round caps and joins, and
`aria-hidden`. Pass it paths, and it will match everything else.

**This is a decision about the current scale, not a principle.** We are open to adopting an
icon library if the icon count grows enough to justify it — hand-drawing paths stops being
cheaper than a dependency somewhere around a dozen icons, and a real set also brings
consistent optical sizing and a much wider vocabulary than anyone wants to draw by hand. If
you find yourself drawing several new icons for one feature, or reaching for a glyph that
would be tedious to draw well, say so and propose the switch rather than quietly adding more
paths.

`ToolbarIcon` is what makes that switch cheap: it is the single seam every icon passes
through, so moving to a library means changing that wrapper and the icon constants beside
it, not hunting SVG across the codebase. Keep new icons going through it for that reason.

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

The dev server is usually the user's, on :5173 (web) and :8787 (API). **Check before
starting your own:**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/
```

If it's already up, use it. If you do start something, stop it when you're done. Use the
browser preview tools rather than `bash` for anything server-shaped.

## Verifying

Verify UI changes in the browser and show the result — don't ask the user to check
manually. Screenshot the change, and confirm computed styles when the point of the change is
visual. Test both breakpoints when layout is involved.

`pnpm --filter @unbent/web test` and `npx tsc --noEmit` both need to pass. Don't mutate the
user's real data to test a control; if you do it by accident, put it back and say so.

## The local database is disposable — but ask

Wiping local notes during development is fine and has been offered explicitly. **Ask first
every time**, because the plan is one final import from the real Evernote corpus and the
state may have changed since the last conversation.

That corpus is ~3 GB and ~13K notes, mostly PDFs — this is a paperless-office use case.
Performance assumptions should hold at that scale, not at the scale of a dev database with
90 notes.
