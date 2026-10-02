import { useEffect, useState } from 'react';
import { currentLibrary, subscribeLibrary } from './library.js';
import type { Outbox, SyncStatus } from './actions.js';

const nothing: SyncStatus = { pending: 0, durable: false, conflicts: new Map() };

/**
 * The open library's outbox, for a component that shows what the server has not taken
 * yet or hears a conflict; null until the library opens, and on a device with no local
 * copy, where every write is a request that has already been answered. Follows the
 * library: the one open at mount is not the one open after a back/forward-cache restore
 * or a change of account, and may not be open yet at all (`subscribeLibrary`).
 */
export function useOutbox(): Outbox | null {
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const follow = () => {
      const mine = ++generation;
      const open = currentLibrary();
      if (!open) {
        setOutbox(null);
        return;
      }
      open.then(
        (lib) => {
          if (alive && mine === generation) setOutbox('outbox' in lib ? (lib as { outbox: Outbox }).outbox : null);
        },
        () => {
          if (alive && mine === generation) setOutbox(null);
        },
      );
    };
    follow();
    const stop = subscribeLibrary(follow);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return outbox;
}

/** How many writes wait for the server, and the conflicts waiting on a choice. */
export function useSyncStatus(): SyncStatus {
  const outbox = useOutbox();
  const [status, setStatus] = useState<SyncStatus>(nothing);
  useEffect(() => {
    if (!outbox) return;
    return outbox.subscribe(setStatus);
  }, [outbox]);
  return outbox ? status : nothing;
}
