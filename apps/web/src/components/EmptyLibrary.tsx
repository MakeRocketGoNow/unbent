import { Link } from '@tanstack/react-router';
import { Button } from './Button.js';
import { EmptyLibraryIcon } from './icons.js';
import { EmptyState } from './EmptyState.js';
import { useCreateNote } from '../useCreateNote.js';

/**
 * What an account with no notes at all is shown: an offer to bring notes in, and to start
 * one.
 *
 * A new account used to land on a list reading "No notes yet." and nothing else, which
 * says what is wrong and not what to do about it. The two things anyone arriving here does
 * next are bring an archive over from where they kept it before, or write something, so
 * those are the two actions, and nothing else competes with them.
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
          <Button size="large" className="empty-state-action" onClick={() => void createNote({ tags: [], notebook: null })}>
            New note
          </Button>
        </>
      }
    />
  );
}
