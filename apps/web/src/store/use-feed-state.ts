import { useEffect, useState } from 'react';
import { currentLibrary, subscribeLibrary } from './library.js';
import type { FeedState } from './feed.js';

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
