import { useEffect, useState } from 'react';
import { currentLibrary } from './library.js';
import type { FeedState } from './feed.js';

/**
 * The feed engine's state for the open library — whether the copy is current, being
 * taken for the first time, or could not be brought current — for the line that says so.
 * Null until the library opens, and on a device with no local copy.
 */
export function useFeedState(): FeedState | null {
  const [state, setState] = useState<FeedState | null>(null);
  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    const open = currentLibrary();
    if (!open) return;
    open.then(
      (lib) => {
        if (!alive || !('subscribe' in lib)) return;
        const l = lib as { subscribe: (fn: (s: FeedState) => void) => () => void; state: () => FeedState };
        setState(l.state());
        unsubscribe = l.subscribe(setState);
      },
      () => {},
    );
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);
  return state;
}
