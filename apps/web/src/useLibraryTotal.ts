import { createContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { libraryTotalQuery } from './queries.js';
import { isWhole } from './store/feed.js';
import { useFeedState } from './store/use-feed-state.js';

/**
 * How many live notes the account holds, or null while that is not known yet.
 *
 * The one place the notes view asks "is this account empty?" — the list's empty state on a
 * phone and the workspace's on a desktop both read it. Null whenever the answer
 * would be a guess: the library still opening or taking its first copy, a count not taken
 * yet, a count that failed. Every caller treats null as "draw nothing new", which is what
 * keeps the empty state from flashing for an account whose notes are a page away.
 *
 * The whole-account count, not the list's: an empty notebook, tag, filter or search is not
 * an empty account, and each caller decides separately whether the scope on screen is the
 * whole account. See `libraryTotalQuery` for how whole and count are read together.
 *
 * The feed's state is followed only to know when to count again. A device with no library
 * — no file system to keep one in (`PersistenceUnavailableError`), or a test — has no feed
 * state, and its count comes from the server or the test's library, both of which are
 * whole.
 *
 * `enabled` is the caller saying when the answer can matter, and every caller asks only
 * then. The query is re-run on every change to the library while it is watched, and on a
 * device with no library each run is a request to the server; but every caller only acts
 * on an account with no notes, so a list showing a row, or a scope that is not the whole
 * account, has nothing to ask. Off, the answer is null, the same "draw nothing new" as
 * unknown.
 */
export function useLibraryTotal(enabled = true): number | null {
  const feed = useFeedState();
  const total = useQuery(libraryTotalQuery(feed ? isWhole(feed) : null, enabled));
  return enabled && total.isSuccess ? total.data : null;
}

/**
 * Whether the notes view's address shows the whole account: All notes, with no notebook,
 * tag, field filter, date range or search applied. The scope the empty state is allowed
 * in, because only there does "no notes here" mean "no notes at all". The sort and the
 * view are not scope and do not count.
 */
export function showsWholeAccount(search: {
  notebook?: string | undefined;
  tag?: readonly string[] | undefined;
  field?: readonly unknown[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
}): boolean {
  return (
    !search.notebook &&
    (search.tag?.length ?? 0) === 0 &&
    (search.field?.length ?? 0) === 0 &&
    !search.from &&
    !search.to &&
    !search.q?.trim()
  );
}

/**
 * How many rows the notes column has loaded, for the workspace pane beside it.
 *
 * The pane only acts on an account with no notes, so it asks for the total only while the
 * column shows no rows — on All notes those rows are the account's. Read from the
 * column rather than from a list query of the pane's own: the column's query is keyed by
 * its order, which on All notes is often a remembered one, so a query of `notesQuery({})`
 * here would be a second list to keep in step rather than the same one. `NotesLayout`
 * provides it around the routed workspace. Null while the column's first load is pending,
 * or while it still shows the previous place's rows: its rows say nothing about the
 * account then, so the pane waits rather than counting an archive on every open. Zero
 * where nothing provides it — a test mounting the pane alone — which the pane reads as a
 * column with no rows, and asks.
 */
export const ListRowsContext = createContext<number | null>(0);
