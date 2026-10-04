import { reposFor } from './repos.js';
import type { Env } from '../types.js';

/**
 * The note a new account finds waiting in its inbox.
 *
 * A brand-new account used to open on a list that said "No notes yet." and nothing else:
 * no hint of what a note can hold, where the import is, or that the editor saves on its
 * own. A note is the one place that can show all of that by being it — a checklist that
 * ticks, a table, a link that goes somewhere — so the welcome is a note rather than a tour
 * or a modal, and the person learns the editor by editing the thing that explains it.
 *
 * An ordinary note in every respect: in no notebook, untagged, editable, trashable. Nothing
 * in the schema marks it as special, and nothing should start to: an account that deletes
 * it, edits it into a shopping list or exports it is using it as intended, and code that
 * looked for it by title or flag would break on exactly those accounts. The web app's empty
 * state (`EmptyLibrary`) covers the account without one, whether it deleted this or never
 * got it.
 *
 * Written for every instance, not for unbent.app. A self-hosted instance creates the same
 * note, so the text names no host and no price, and every link in it is a path on this
 * site — the unit test beside this file holds both, and that each path is a page the web
 * app has. Paths rather than addresses also survive an export and an import into another
 * instance, where an absolute link would point back at the one it came from.
 *
 * Short on purpose: nobody reads a manual, and the note's last line tells them they may
 * delete it. No image, though one would be nice — it would need a stored file per
 * account, which is a blob in R2 for every sign-up to say hello.
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

/**
 * Writes the welcome note into a just-created account's store.
 *
 * Through `reposFor`, the same scoped repos every route uses, so the note can only land in
 * the account named — there is no second way into a store to keep isolated. A plain
 * `create`: no client id to replay (this runs once, from the account's creation), no
 * revision (a create replaces nothing), and the store's own clock for both dates, so the
 * note is as new as the account.
 */
export async function createWelcomeNote(
  env: Pick<Env, 'USER_STORE' | 'STORE_JURISDICTION'>,
  userId: string,
): Promise<void> {
  const { notes } = reposFor(env, userId);
  await notes.create({
    id: crypto.randomUUID(),
    title: WELCOME_TITLE,
    body: WELCOME_BODY,
    tags: [],
    notebook: null,
  });
}
