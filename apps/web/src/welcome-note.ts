/**
 * The sample note an empty account can ask for: "See a sample note", the quiet third
 * action in `EmptyLibrary`.
 *
 * A note is the one place that can show what a note holds by being it — a checklist that
 * ticks, a table, a link that goes somewhere — so the tour is a note rather than a modal,
 * and the person learns the editor by editing the thing that explains it. It is made on
 * request, on the device, like any note: through `useCreateNote` and `store/actions.ts`,
 * so it is written offline as well as on, syncs like any other, and is an ordinary note
 * afterwards — in no notebook, untagged, editable, trashable, with nothing marking it as
 * special. Code that looked for it by title would break on the account that renamed it.
 *
 * It used to be written into every account at sign-up, by the API, and that was tried and
 * taken back. A new account should meet the import offer first, and a note waiting in its
 * list put a manual in front of it; an account that went on to import its archive kept a
 * stray note it never asked for; and opening the note for someone who had not seen it yet
 * needed a per-device flag, where an action in the empty state is seen exactly when the
 * account is empty and asked for exactly once.
 *
 * Written for every instance, not for unbent.app: a self-hosted instance offers the same
 * note, so the text names no host and no price, and every link in it is a path on this
 * site — the test beside this file holds both, and that each path is a page the router
 * has. Paths rather than addresses also survive an export and an import into another
 * instance, where an absolute link would point back at the one it came from; a click on
 * one is followed in place (`openSitePath`).
 *
 * Short on purpose: nobody reads a manual, and the note's last line says it may be
 * deleted. No image, though one would be nice — a picture in a note is a stored file, and
 * this one would be uploaded again for every account that asked for the note.
 *
 * The table's rows are 31 characters, padded so the columns line up, and both are on
 * purpose. The rich editor draws a table as its own source in a fixed-width face, and a
 * row that does not fit wraps mid-cell; 31 is what a 320px phone holds. With full
 * sentences in the cells, the first table a new person saw on a phone was a paragraph
 * with pipes in it. A cell that needs more words belongs in the prose above it.
 */
export const WELCOME_TITLE = 'Welcome to Unbent';

export const WELCOME_BODY = `This is a note. Start typing anywhere; it saves as you go.

## What a note can hold

- **Bold**, *italic*, \`code\` and [links](/settings/about)
- Files: drop in a PDF or a photo, and a PDF's text becomes searchable
- Checklists and tables, like the ones below

## A few things to try

- [x] Sign in
- [ ] Tick this box
- [ ] [Bring your notes over from Evernote or Notion](/settings/import)
- [ ] [Connect an assistant or another app](/settings/connected-apps)

## Keeping things in order

| Use       | For             |
| --------- | --------------- |
| Notebooks | A note's home   |
| Tags      | What it's about |
| Fields    | Dates, ratings  |

## Your notes stay yours

Every note is plain Markdown, saved exactly as you typed it. [Export](/settings/export) hands all of it back as files whenever you like.

Finished with this note? Delete it. Nothing depends on it.
`;
