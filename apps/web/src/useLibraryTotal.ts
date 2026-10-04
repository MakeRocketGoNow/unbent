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
 */
export function useLibraryTotal(): number | null {
  const feed = useFeedState();
  const total = useQuery(libraryTotalQuery(feed ? isWhole(feed) : null));
  return total.isSuccess ? total.data : null;
}
