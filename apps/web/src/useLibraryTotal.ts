import { useQuery } from '@tanstack/react-query';
import { libraryTotalQuery } from './queries.js';
import { isWhole } from './store/feed.js';
import { useFeedState } from './store/use-feed-state.js';

/**
 * How many live notes the account holds, or null while that is not known yet.
 *
 * The one place the notes view asks "is this account empty?" — the list's empty state on a
 * phone and the workspace's on a desktop both read it — and "is this the account's first
 * note?", which the first-run opening of the welcome note reads. Null whenever the answer
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
 * on none or one, so a list showing two rows, or a scope that is not the whole account,
 * has nothing to ask. Off, the answer is null, the same "draw nothing new" as unknown.
 */
export function useLibraryTotal(enabled = true): number | null {
  const feed = useFeedState();
  const total = useQuery(libraryTotalQuery(feed ? isWhole(feed) : null, enabled));
  return enabled && total.isSuccess ? total.data : null;
}

/**
 * Whether the notes view's address shows the whole account: All notes, with no notebook,
 * tag, field filter, date range or search applied. The scope the empty state and the
 * first-run opening are allowed in, because only there does "no notes here" mean "no
 * notes at all". The sort and the view are not scope and do not count.
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
