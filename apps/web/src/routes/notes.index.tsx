import { useContext, useEffect } from 'react';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { EmptyLibrary } from '../components/EmptyLibrary.js';
import { notesQuery } from '../queries.js';
import { useAppSession } from '../useAppSession.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { ListRowsContext, showsWholeAccount, useLibraryTotal } from '../useLibraryTotal.js';
import {
  FIRST_RUN_WINDOW_MS,
  createdAtMs,
  firstNoteOpened,
  rememberFirstNoteOpened,
  shouldOpenFirstNote,
} from '../first-run.js';

/** `/notes` with no note selected: the list is shown, the workspace is empty. */
export const Route = createFileRoute('/notes/')({
  component: NoNoteOpen,
});

/**
 * The workspace with no note in it.
 *
 * For an account with no notes at all, the pane is where the empty state goes on a
 * desktop (`EmptyLibrary`): it is the big, otherwise idle half of the screen, and the
 * list column beside it says nothing rather than the same thing again. For a brand-new
 * account it opens the welcome note instead, once (`first-run.ts`). Anywhere else — an
 * account with notes, or a notebook, tag, filter or search that matched nothing — it is
 * the line it always was.
 * On a phone this pane is hidden while the list shows, and the list draws the empty state
 * itself, so neither is done here.
 */
function NoNoteOpen() {
  // By the route's id rather than its object, so a test can mount this under a `/notes`
  // route of its own (see notes-empty-library.test.tsx); the search is the same either way.
  const search = useSearch({ from: '/notes' });
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const wholeAccount = showsWholeAccount(search);
  // Both things this pane does with the total are desktop-only, need the whole account,
  // and need it to hold none or one — so not while the column beside already shows two.
  const rows = useContext(ListRowsContext);
  const total = useLibraryTotal(!isMobile && wholeAccount && (rows === null || rows <= 1));
  const opening = useOpenFirstNote({ twoPane: !isMobile, wholeAccount, total, newRequested: search.new === 1 });

  if (!isMobile && total === 0 && wholeAccount) {
    return (
      <section className="workspace empty empty-state-pane">
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
function useOpenFirstNote(where: {
  twoPane: boolean;
  wholeAccount: boolean;
  total: number | null;
  newRequested: boolean;
}): boolean {
  const { session } = useAppSession();
  const navigate = useNavigate();
  const userId = session?.user.id ?? null;
  const createdAt = createdAtMs(session?.user.createdAt);
  const now = Date.now();
  const wanted =
    userId !== null &&
    shouldOpenFirstNote({
      ...where,
      createdAt,
      now,
      alreadyOpened: firstNoteOpened(userId, now),
    });
  // The account's one note, from the same unfiltered list the column beside this shows.
  const list = useInfiniteQuery({ ...notesQuery({}), enabled: wanted });
  const noteId = wanted ? list.data?.pages[0]?.items[0]?.id : undefined;
  useEffect(() => {
    if (!noteId || !userId || createdAt === null) return;
    rememberFirstNoteOpened(userId, createdAt + FIRST_RUN_WINDOW_MS, Date.now());
    // Without `new`, whatever else the address carries: the predicate stands down while it
    // is set, but the search is read again at the moment of navigating, and a request that
    // arrived in between must not ride along onto the note and make one more on a reload.
    void navigate({
      to: '/notes/$noteId',
      params: { noteId },
      search: ({ new: _, ...p }) => p,
      replace: true,
    });
  }, [noteId, userId, createdAt, navigate]);
  // Blank only while the list can still hand over the note. A list that failed, or came
  // back without a row (the note went between the count and the list), has nothing to
  // open, and the pane goes back to its line rather than staying blank for good.
  return wanted && !list.isError && !(list.isSuccess && noteId === undefined);
}
