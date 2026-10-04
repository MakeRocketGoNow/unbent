import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { EmptyLibrary } from '../components/EmptyLibrary.js';
import { notesQuery } from '../queries.js';
import { useAppSession } from '../useAppSession.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { showsWholeAccount, useLibraryTotal } from '../useLibraryTotal.js';
import { createdAtMs, firstNoteOpened, rememberFirstNoteOpened, shouldOpenFirstNote } from '../first-run.js';
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
 * list column beside it keeps its one quiet line. For a brand-new account it opens the
 * welcome note instead, once (`first-run.ts`). Anywhere else — an account with notes, or
 * a notebook, tag, filter or search that matched nothing — it is the line it always was.
 * On a phone this pane is hidden while the list shows, and the list draws the empty state
 * itself, so neither is done here.
 */
function NoNoteOpen() {
  const search = NotesRoute.useSearch();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const total = useLibraryTotal();
  const wholeAccount = showsWholeAccount(search);
  const opening = useOpenFirstNote({ twoPane: !isMobile, wholeAccount, total });

  if (!isMobile && total === 0 && wholeAccount) {
    return (
      <section className="workspace empty empty-library-pane">
        <EmptyLibrary />
      </section>
    );
  }
  // Blank for the moment before the note opens, rather than telling someone to select
  // the note that is about to appear.
  if (opening) return <section className="workspace empty" />;
  return (
    <section className="workspace empty">
      <p className="muted">Select a note, or create one.</p>
    </section>
  );
}

/**
 * Opens a brand-new account's one note in this pane, when `shouldOpenFirstNote` says so,
 * and answers whether it is about to. Replaces the history entry rather than adding one:
 * the bare `/notes` it replaces was never a page anyone looked at, and Back should not
 * stop on it. Remembers that it did before navigating, so the list is left alone from
 * then on.
 */
function useOpenFirstNote(where: { twoPane: boolean; wholeAccount: boolean; total: number | null }): boolean {
  const { session } = useAppSession();
  const navigate = useNavigate();
  const userId = session?.user.id ?? null;
  const wanted =
    userId !== null &&
    shouldOpenFirstNote({
      ...where,
      createdAt: createdAtMs(session?.user.createdAt),
      now: Date.now(),
      alreadyOpened: firstNoteOpened(userId),
    });
  // The account's one note, from the same unfiltered list the column beside this shows.
  const list = useInfiniteQuery({ ...notesQuery({}), enabled: wanted });
  const noteId = wanted ? list.data?.pages[0]?.items[0]?.id : undefined;
  useEffect(() => {
    if (!noteId || !userId) return;
    rememberFirstNoteOpened(userId);
    void navigate({ to: '/notes/$noteId', params: { noteId }, search: (p) => p, replace: true });
  }, [noteId, userId, navigate]);
  return wanted;
}
