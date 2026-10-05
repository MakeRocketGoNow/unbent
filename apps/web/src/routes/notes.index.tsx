import { useContext } from 'react';
import { createFileRoute, useSearch } from '@tanstack/react-router';
import { EmptyLibrary } from '../components/EmptyLibrary.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { ListRowsContext, showsWholeAccount, useLibraryTotal } from '../useLibraryTotal.js';
import { useHoldWhileCreating } from '../useCreateNote.js';

/** `/notes` with no note selected: the list is shown, the workspace is empty. */
export const Route = createFileRoute('/notes/')({
  component: NoNoteOpen,
});

/**
 * The workspace with no note in it.
 *
 * For an account with no notes at all, the pane is where the empty state goes on a
 * desktop (`EmptyLibrary`): it is the big, otherwise idle half of the screen, and the
 * list column beside it says nothing rather than the same thing again. Anywhere else — an
 * account with notes, or a notebook, tag, filter or search that matched nothing — it is
 * the line it always was. On a phone this pane is hidden while the list shows, and the
 * list draws the empty state itself, so it is never drawn here.
 */
function NoNoteOpen() {
  // By the route's id rather than its object, so a test can mount this under a `/notes`
  // route of its own (see notes-empty-library.test.tsx); the search is the same either way.
  const search = useSearch({ from: '/notes' });
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const wholeAccount = showsWholeAccount(search);
  // Asked only where the answer can draw something: at the two-pane width, on the whole
  // account, and while the column beside shows no rows — a column with a row in it is an
  // account with a note, and an archive must not be recounted on every change for that.
  const rows = useContext(ListRowsContext);
  const total = useLibraryTotal(!isMobile && wholeAccount && (rows === null || rows === 0));
  // Held while a note asked for from it is being made, so "Select a note" does not flash
  // between the empty state and the note opening; see the hook.
  const empty = useHoldWhileCreating(!isMobile && total === 0 && wholeAccount);

  if (empty) {
    return (
      <section className="workspace empty empty-state-pane">
        <EmptyLibrary />
      </section>
    );
  }
  return (
    <section className="workspace empty">
      <p className="muted">Select a note, or create one.</p>
    </section>
  );
}
