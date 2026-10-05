import { Link } from '@tanstack/react-router';
import { Button } from './Button.js';
import { EmptyLibraryIcon } from './icons.js';
import { EmptyState } from './EmptyState.js';
import { useCreateNote, useCreatingNote } from '../useCreateNote.js';
import { WELCOME_BODY, WELCOME_TITLE } from '../welcome-note.js';

/**
 * What an account with no notes at all is shown: an offer to bring notes in, to start one,
 * and, more quietly, to see what a note can be.
 *
 * A new account used to land on a list reading "No notes yet." and nothing else, which
 * says what is wrong and not what to do about it. The two things anyone arriving here does
 * next are bring an archive over from where they kept it before, or write something, so
 * those are the two buttons, side by side, and the import is the filled one.
 *
 * The third, "See a sample note", is quiet and on a line of its own (`EmptyState`'s
 * `aside`) because it is not a third equal choice: it is for someone who wants to look
 * around before choosing. It makes the note in `welcome-note.ts` through the same action
 * as New, and opens it; the account then has a note, so this state leaves on its own. That
 * note used to be written into every account at sign-up, and was taken back: a new
 * account should meet the import offer first, a note waiting in the list put a manual in
 * front of it and stayed behind as a stray in every imported library, and knowing whether
 * someone had seen it needed a per-device flag. Offered here, it is seen exactly when the
 * account is empty and made only when asked for.
 *
 * Both buttons that make a note are disabled while one is being made, so a second press
 * cannot make a second note; a failure is logged, as New's always has been, and they
 * come back.
 *
 * Only for an account that is genuinely empty, which the callers decide with
 * `useLibraryTotal` — never for an empty notebook, tag, filter or search, where the list's
 * one-line message stays, since offering the import there would read as filling that
 * notebook. One drawing at each width, never two at once: in the list on a phone, where
 * the list is the whole screen, and in the workspace pane on a desktop, beside a list
 * column that then says nothing, rather than the same fact a second time.
 *
 * Drawn with `EmptyState`, the stack it shares with `NotebookMissing`, which says why it
 * is a labelled region and why the heading's level is the caller's: an `h2` in the
 * desktop's pane, an `h3` inside the phone's list.
 */
export function EmptyLibrary({ heading = 'h2' }: { heading?: 'h2' | 'h3' }) {
  const createNote = useCreateNote();
  const making = useCreatingNote();
  return (
    <EmptyState
      icon={<EmptyLibraryIcon />}
      heading="No notes yet"
      headingLevel={heading}
      lead="Bring everything over from Evernote or Notion, or start with a blank page."
      actions={
        <>
          {/* A link wearing the filled button's shape, as the front page's call to action
              does: it goes to another page — it can be opened in a new tab, middle-clicked
              and copied — so it is a link, and it is the thing this state is for, so it is
              filled. `Button` deliberately renders no anchors; see its header. First, so
              it is first in the tab order as well as on the left. */}
          <Link to="/settings/import" className="btn btn-primary btn-large empty-state-action">
            Import from Evernote or Notion
          </Link>
          {/* Exactly what New does from All notes, through the same action: the account is
              empty, so there is no notebook or tag on screen to file the note under. */}
          <Button
            size="large"
            className="empty-state-action"
            disabled={making}
            onClick={() => void createNote({ tags: [], notebook: null })}
          >
            New note
          </Button>
        </>
      }
      aside={
        // Large for its height — a 44px target under a thumb — and quiet for its weight,
        // so it reads as an aside under the two choices rather than a third one.
        <Button
          variant="quiet"
          size="large"
          disabled={making}
          onClick={() => void createNote({ tags: [], notebook: null, title: WELCOME_TITLE, body: WELCOME_BODY })}
        >
          See a sample note
        </Button>
      }
    />
  );
}
