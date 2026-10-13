import { useEffect, useState, useSyncExternalStore } from 'react';
import { currentLibrary, libraryElsewhere, subscribeLibrary } from './library.js';
import type { SyncStatus } from './actions.js';
import type { OutboxView } from './client-library.js';
import type { KeepStatus, Keeper } from './keep.js';

const nothing: SyncStatus = { pending: 0, durable: false, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() };

/**
 * The open library's outbox, for a component that shows what the server has not taken
 * yet or hears a conflict; null until the library opens, and on a device with no local
 * copy, where every write is a request that has already been answered. In a tab that is
 * a client of the holding tab it is the holder's outbox as mirrored there
 * (`client-library.ts`): the same status, the same conflicts, and the few actions a
 * component takes on it sent across. Follows the library: the one open at mount is not
 * the one open after a back/forward-cache restore or a change of account, and may not be
 * open yet at all (`subscribeLibrary`).
 */
export function useOutbox(): OutboxView | null {
  const [outbox, setOutbox] = useState<OutboxView | null>(null);
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
          if (alive && mine === generation) setOutbox('outbox' in lib ? (lib as { outbox: OutboxView }).outbox : null);
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

/**
 * Whether this device has a library: `'none'` when nobody has opened one on this tab or
 * the device cannot keep one, `'opening'` while it opens, `'open'` after. For the chrome
 * that must not tell a device able to keep its changes that it cannot, in the moment
 * before the library has opened (review of #232).
 */
export function useLibraryPresence(): 'none' | 'opening' | 'open' {
  const [presence, setPresence] = useState<'none' | 'opening' | 'open'>(() => (currentLibrary() ? 'opening' : 'none'));
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const follow = () => {
      const mine = ++generation;
      const open = currentLibrary();
      if (!open) {
        setPresence('none');
        return;
      }
      setPresence('opening');
      open.then(
        () => {
          if (alive && mine === generation) setPresence('open');
        },
        () => {
          if (alive && mine === generation) setPresence('none');
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
  return presence;
}

/**
 * The account whose library another tab of this device holds, or null. For Settings →
 * Offline, which says so and offers to bring the library here (`library-lock.ts`). Not
 * for the status line or the offline banner any more: a tab that does not hold the
 * library is the holder's client and works as the holder does, offline included
 * (`client-library.ts`), so nothing in the chrome tells the tabs apart.
 */
export function useLibraryElsewhere(): string | null {
  return useSyncExternalStore(subscribeLibrary, libraryElsewhere, () => null);
}

/**
 * Whether this tab's library is another tab's client library (`store/client-library.ts`)
 * — one that has attached to a holder at least once, and works through whichever holder
 * serves — as opposed to the holder's own, none, or an attach no holder has answered
 * yet, which is refused after the open's bound and reads the server. For Settings →
 * Offline, which says which the tab is.
 */
export function useLibraryClient(): boolean {
  const [client, setClient] = useState(false);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const follow = () => {
      const mine = ++generation;
      const open = currentLibrary();
      if (!open) {
        setClient(false);
        return;
      }
      open.then(
        (lib) => {
          if (alive && mine === generation) setClient('remote' in lib && lib.remote === true);
        },
        () => {
          if (alive && mine === generation) setClient(false);
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
  return client;
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

const keepingNothing: KeepStatus = { supported: false, kept: new Set(), counted: false, wanted: { files: 0, bytes: 0 }, have: { files: 0, bytes: 0 }, fetching: false, problem: null };

/**
 * The open library's keeper and what it holds: which notebooks are kept on this device,
 * how much of them has arrived. Null and `supported: false` until the library opens and
 * on a device with no local copy, where nothing can be kept — the controls that offer
 * keeping read `supported` and are not drawn without it.
 */
export function useKeeper(): { keeper: Keeper | null; status: KeepStatus } {
  const [keeper, setKeeper] = useState<Keeper | null>(null);
  const [status, setStatus] = useState<KeepStatus>(keepingNothing);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const follow = () => {
      const mine = ++generation;
      const open = currentLibrary();
      if (!open) {
        setKeeper(null);
        return;
      }
      open.then(
        (lib) => {
          if (alive && mine === generation) setKeeper('keeper' in lib ? (lib as { keeper: Keeper }).keeper : null);
        },
        () => {
          if (alive && mine === generation) setKeeper(null);
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
  useEffect(() => {
    if (!keeper) return;
    return keeper.subscribe(setStatus);
  }, [keeper]);
  return { keeper, status: keeper ? status : keepingNothing };
}
