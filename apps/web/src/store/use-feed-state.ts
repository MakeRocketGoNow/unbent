import { useEffect, useState } from 'react';
import { currentLibrary, subscribeLibrary } from './library.js';
import { useLibraryPresence } from './use-outbox.js';
import type { FeedState } from './feed.js';

/**
 * Whether the library is still arriving on this device, and how: `'opening'` while the
 * store opens — on a first open that is the persistence worker, a 1.7 MB chunk, fetched
 * and booted, several seconds on a phone — then `'copying'` while the first snapshot
 * walk runs, with its count. Null once the copy is on the device, and on a device that
 * keeps none. What the status line and the list's empty state read: an empty app with
 * no word about it was what the first open looked like (seen on a phone, 2026-10-02).
 */
export function useLibraryArriving(): { stage: 'opening' | 'copying'; applied: number; total: number | null } | null {
  const presence = useLibraryPresence();
  const state = useFeedState();
  if (presence === 'opening') return { stage: 'opening', applied: 0, total: null };
  if (presence === 'open' && state?.phase === 'hydrating') return { stage: 'copying', applied: state.applied, total: state.total };
  // Open, but the engine has not read its cursor yet: between the store opening and the
  // first page, a gap the line would otherwise blink out of. A warm open passes through
  // this for the one read of the cursor and no longer.
  if (presence === 'open' && state?.phase === 'starting' && state.cursor === null && state.pulls === 0) return { stage: 'opening', applied: 0, total: null };
  return null;
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
