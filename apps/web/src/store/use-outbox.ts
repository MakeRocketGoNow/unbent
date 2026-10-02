import { useEffect, useState } from 'react';
import { currentLibrary } from './library.js';
import type { Outbox, SyncStatus } from './actions.js';

const nothing: SyncStatus = { pending: 0, durable: false, conflicts: new Map() };

/**
 * The open library's outbox, for a component that shows what the server has not taken
 * yet or hears a conflict; null until the library opens, and on a device with no local
 * copy, where every write is a request that has already been answered.
 */
export function useOutbox(): Outbox | null {
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  useEffect(() => {
    let alive = true;
    const open = currentLibrary();
    if (!open) return;
    open.then(
      (lib) => {
        if (alive && 'outbox' in lib) setOutbox((lib as { outbox: Outbox }).outbox);
      },
      () => {},
    );
    return () => {
      alive = false;
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
