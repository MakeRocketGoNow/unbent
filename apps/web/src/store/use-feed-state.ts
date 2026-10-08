import { useEffect, useState } from 'react';
import { currentLibrary, subscribeLibrary } from './library.js';
import { useLibraryPresence } from './use-outbox.js';
import { isWhole, type FeedState } from './feed.js';

/**
 * How long the store may take to open before the line says it is opening. A warm open on
 * a fast device takes under a hundred milliseconds, and a line that blinked on every one
 * of those would be the jank; a first open, or a phone, takes long enough to be told.
 */
const OPENING_GRACE_MS = 250;

/**
 * Whether the library is still arriving on this device, and how: `'opening'` while the
 * store opens — on a first open that is the persistence worker, a 1.7 MB chunk, fetched
 * and booted, several seconds on a phone — then `'copying'` while the first snapshot
 * walk runs, with its count. Null once the copy is on the device, and on a device that
 * keeps none. What the status line and the list's empty state read: an empty app with
 * no word about it was what the first open looked like (seen on a phone, 2026-10-02).
 * The opening stage is reported only once it has lasted the grace period; the copy, real
 * work with a count, at once.
 */
export function useLibraryArriving(): { stage: 'opening' | 'copying'; applied: number; total: number | null } | null {
  const presence = useLibraryPresence();
  const state = useFeedState();
  // Open, but the engine has not read its cursor yet: between the store opening and the
  // first page, a gap the line would otherwise blink out of.
  const opening = presence === 'opening' || (presence === 'open' && state?.phase === 'starting' && state.cursor === null && state.pulls === 0);
  const [openingLong, setOpeningLong] = useState(false);
  useEffect(() => {
    if (!opening) {
      setOpeningLong(false);
      return;
    }
    const timer = setTimeout(() => setOpeningLong(true), OPENING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [opening]);
  // A copy that failed partway is still arriving: the engine tries it again (`retry` in
  // `feed.ts`), and the line going away between tries would leave a list with half the
  // notes in it and nothing to say the rest are coming.
  const copying = state?.phase === 'hydrating' || (state?.phase === 'failed' && !isWhole(state));
  if (presence === 'open' && state && copying) return { stage: 'copying', applied: state.applied, total: state.total };
  if (opening && openingLong) return { stage: 'opening', applied: 0, total: null };
  return null;
}

/**
 * Whether what the views read from this device is the whole account: a library whose walk
 * has finished (`isWhole`), or no library at all, where every read is the server's and so
 * whole. False while the store opens and while its first copy, or a copy after a `reset`,
 * is under way — when a notebook not in the list yet is still on its way, not missing.
 */
export function useLibraryWhole(): boolean {
  const presence = useLibraryPresence();
  const state = useFeedState();
  if (presence === 'none') return true;
  return presence === 'open' && state !== null && isWhole(state);
}

type Subscribable = { subscribe: (fn: (s: FeedState) => void) => () => void; state: () => FeedState };

/**
 * The feed engine's state for the open library — whether the copy is current, being
 * taken for the first time, or could not be brought current — for the line that says so.
 * Null until the library opens, and on a device with no local copy. Follows the library
 * as `useOutbox` does, for the same reason.
 */
export function useFeedState(): FeedState | null {
  const [state, setState] = useState<FeedState | null>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let unsubscribe: (() => void) | undefined;
    const follow = () => {
      const mine = ++generation;
      unsubscribe?.();
      unsubscribe = undefined;
      const open = currentLibrary();
      if (!open) {
        setState(null);
        return;
      }
      open.then(
        (lib) => {
          if (!alive || mine !== generation) return;
          if (!('subscribe' in lib)) {
            setState(null);
            return;
          }
          const l = lib as Subscribable;
          setState(l.state());
          unsubscribe = l.subscribe(setState);
        },
        () => {
          if (alive && mine === generation) setState(null);
        },
      );
    };
    follow();
    const stop = subscribeLibrary(follow);
    return () => {
      alive = false;
      unsubscribe?.();
      stop();
    };
  }, []);
  return state;
}
