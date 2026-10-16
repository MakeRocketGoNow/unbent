# Play Store assets

Everything the Play Console store listing asks for, and how it was made.

## What is here

| File | Play field | Spec |
| --- | --- | --- |
| `listing.md` | App name, short and full description | 30 / 80 / 4000 chars |
| `icon-512.png` | App icon | 512×512 PNG, ≤1 MB |
| `feature-graphic-1024x500.png` | Feature graphic | 1024×500 PNG, ≤15 MB |
| `screenshots/` | Phone screenshots | 1080×2424, native Pixel 9 |
| `screenshots-9x16/` | Phone screenshots | 1080×1920, padded to exactly 9:16 |
| `whatsnew/` | Release notes | 500 chars per locale, uploaded by CI |

## Release notes

`whatsnew/whatsnew-en-US` is what testers see under "What's new". CI passes the directory to
the publish step, so editing that file *is* how the note changes: nothing is entered in Play
Console by hand, and a release whose notes were not updated ships the previous ones.

Write it for someone holding a phone: what is different for them, in their words. The commit
subjects are addressed to whoever changes the code next and make poor release notes.

One file per locale, named `whatsnew-<BCP 47>`: `whatsnew-de-DE` beside the existing one is
all German takes. Play's limit is 500 characters each.

Upload `screenshots/` first: Play accepts modern tall phone ratios in practice. If the form
rejects them for aspect ratio, upload `screenshots-9x16/` instead; it is the same set scaled
and padded with the app's own background colour, so nothing is cropped.

Both sets are 5 shots: over Play's minimum of 2, and over the 4 at ≥1080 px needed to be
eligible for promotion.

## The screenshots

1. `01-note-list.png`, the note list: notebooks, tags, previews
2. `02-editor.png`, a note open: rendered code block, checkboxes, formatting bar
3. `03-search.png`, full-text search with matches highlighted
4. `04-tag-filter.png`, the tag picker, filtered to one tag
5. `05-notebooks.png`, the notebook drawer with per-notebook counts

## How they were produced

Shot on the `Pixel_9_API_36` emulator against a **local dev instance** with ten disposable
sample notes: no real account data. The sample notes are generic (recipes, a bookshelf
build, a packing list) and contain no personal information.

The debug build is normally named "Unbent (debug)", which must not appear in a store
listing. For the shots, `resValue("string", "app_name", …)` in `app/build.gradle.kts` was
temporarily set to "Unbent", the app rebuilt and installed, and the change reverted
afterwards. **`build.gradle.kts` is unmodified in git**: check before committing.

To reproduce:

```sh
pnpm dev                 # note the port it prints; a worktree is not on 5173
pnpm seed:demo --reset --small   # demo@example.com, only the ten sample notes the shots are of
adb reverse tcp:<port> tcp:<port>
```

Point the app at `http://localhost:<port>` from App settings → Unbent address (the site's
Settings → App settings inside the app, or the sign-in screen's Change), make the same
temporary rename, and capture with `adb exec-out screencap -p > shot.png`. The new address
needs its own sign-in; the session for the old one is kept for switching back. The fuller version
of all this is in `AGENTS.md` under "Sample notes, and shooting the app".

## The graphics

`icon.svg` and `feature.svg` are the sources, rendered with `rsvg-convert`. The icon is a
pixel-faithful reproduction of the launcher icon: same white "U" path and same `#2F6B4F`
green as `res/drawable/ic_launcher_{foreground,background}.xml`. Re-render after any change:

```sh
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
rsvg-convert -w 1024 -h 500 feature.svg -o feature-graphic-1024x500.png
```

## Still needed in Play Console

- A support contact email
- Data safety form (the app collects note content and an email address for the account)
- Content rating questionnaire
- Privacy policy URL: `https://unbent.app/privacy`
- Account deletion URL: `https://unbent.app/delete-my-account`
