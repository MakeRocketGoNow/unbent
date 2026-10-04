import { createFileRoute } from '@tanstack/react-router';
import { EmptyLibrary } from '../components/EmptyLibrary.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { showsWholeAccount, useLibraryTotal } from '../useLibraryTotal.js';
import { Route as NotesRoute } from './notes.js';

/** `/notes` with no note selected: the list is shown, the workspace is empty. */
export const Route = createFileRoute('/notes/')({
  component: NoNoteOpen,
});

/**
 * The workspace with no note in it.
 *
 * For an account with no notes at all, the pane is where the empty state goes on a
 * desktop (`EmptyLibrary`): it is the big, otherwise idle half of the screen, and the
 * list column beside it keeps its one quiet line. Anywhere else — an account with notes,
 * or a notebook, tag, filter or search that matched nothing — it is the line it always
 * was. On a phone this pane is hidden while the list shows, and the list draws the empty
 * state itself, so it is never drawn here.
 */
function NoNoteOpen() {
  const search = NotesRoute.useSearch();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const total = useLibraryTotal();
  if (!isMobile && total === 0 && showsWholeAccount(search)) {
    return (
      <section className="workspace empty empty-library-pane">
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
