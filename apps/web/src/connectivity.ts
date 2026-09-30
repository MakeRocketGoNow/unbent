import { useSyncExternalStore } from 'react';
import { onlineManager, type QueryClient } from '@tanstack/react-query';

/**
 * Whether the app can reach its server right now — the one answer the offline banner, the
 * read-only editor and React Query's pausing all read, so they cannot disagree.
 *
 * The browser's `navigator.onLine` is half of it. It is false in airplane mode, which is
 * the case that matters most, but true on a connection that is up and carries nothing —
 * a captive portal, a train's Wi-Fi, a tunnel. So the app's own requests are the other
 * half: one that fails at the network, or one the service worker had to answer from its
 * cache (it marks those, `X-Unbent-Served: cache`), says the server is out of reach
 * whatever the browser thinks. Any real answer from the server says it is back.
 *
 * While the browser believes it is online but requests are failing, nothing would ever
 * say otherwise without a request, so the store asks: `/api/health`, twenty seconds after
 * losing the server and doubling to five minutes. Any HTTP answer counts, a 503 included —
 * health reports a database hiccup with one, and that is a reachable server, not a lost
 * connection. Asked straight away when the app comes back into view, too.
 *
 * Deliberately free of the router and of the page's own modules, so the API client and
 * the session check can report into it without importing either.
 */

let offline = typeof navigator !== 'undefined' ? navigator.onLine === false : false;
/** Requests failing while the browser believes it is online. */
let unreachable = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === offline) return;
  offline = next;
  for (const listener of listeners) listener();
}

function evaluate(): void {
  set(navigator.onLine === false || unreachable);
  schedulePoll();
}

export function offlineNow(): boolean {
  return offline;
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOffline(): boolean {
  return useSyncExternalStore(subscribeConnectivity, offlineNow, () => false);
}

/** A request failed before any answer arrived, or was answered from the worker's cache. */
export function reportUnreachable(): void {
  unreachable = true;
  evaluate();
}

/** The server answered — with anything. */
export function reportReachable(): void {
  if (!unreachable && !offline) return;
  unreachable = false;
  evaluate();
}

const FIRST_POLL = 20_000;
const LAST_POLL = 5 * 60_000;
let pollDelay = FIRST_POLL;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Asks the server whether it is there, when only asking can tell. Not while the browser
 * itself says it is offline — its `online` event will say when that changes, and a request
 * before then can only fail.
 */
function schedulePoll(): void {
  if (!unreachable || navigator.onLine === false) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    pollDelay = FIRST_POLL;
    return;
  }
  if (pollTimer !== undefined) return;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    pollDelay = Math.min(pollDelay * 2, LAST_POLL);
    void probe();
  }, pollDelay);
}

async function probe(): Promise<void> {
  try {
    await fetch('/api/health', { cache: 'no-store' });
    reportReachable();
  } catch {
    schedulePoll();
  }
}

/**
 * Starts listening, and makes React Query's idea of "online" this store's.
 *
 * React Query otherwise follows the browser's `online`/`offline` events alone, so a
 * connection that is up and carries nothing looked online to it forever, and it never
 * read `navigator.onLine` at startup either. Here it pauses retries exactly when the
 * banner shows, and resumes them when the banner goes.
 *
 * On the way back, everything on screen is fetched again rather than only what React
 * Query has marked stale: anything read while offline came from the worker's cache, and
 * could be older than the thirty seconds that would otherwise protect it. That is also
 * what lets a note opened from the cache be edited again (see `Workspace`).
 */
export function installConnectivity(queryClient: QueryClient): void {
  window.addEventListener('online', () => {
    // The browser says the network is back; trust it until a request says otherwise.
    unreachable = false;
    evaluate();
  });
  window.addEventListener('offline', evaluate);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && unreachable && navigator.onLine !== false) {
      void probe();
    }
  });

  onlineManager.setEventListener((setOnline) => {
    setOnline(!offline);
    return subscribeConnectivity(() => setOnline(!offline));
  });

  let was = offline;
  subscribeConnectivity(() => {
    if (was && !offline) void queryClient.invalidateQueries();
    was = offline;
  });
}

/**
 * The notes whose last read came from the service worker's cache rather than the server.
 *
 * Such a note stays locked even once the connection is back, until the server has
 * answered for it. Its copy may be older than one saved from another device, and the
 * editor seeds its draft once per note and saves without a precondition (that is MAK-113)
 * — so unlocking it on the stale text would let the first keystroke save the old body
 * over the newer one. The refetch on reconnect is what clears it; `Workspace` then seeds
 * again from the server's copy.
 */
const readFromCache = new Set<string>();
const noteListeners = new Set<() => void>();

/** Called for every read of one note, with where the answer came from. */
export function noteRead(id: string, fromCache: boolean): void {
  if (readFromCache.has(id) === fromCache) return;
  if (fromCache) readFromCache.add(id);
  else readFromCache.delete(id);
  for (const listener of noteListeners) listener();
}

export function useNoteReadFromCache(id: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      noteListeners.add(listener);
      return () => {
        noteListeners.delete(listener);
      };
    },
    () => readFromCache.has(id),
    () => false,
  );
}

/** Test seam: back to a browser that is online, with nothing failing and nothing polling. */
export function resetConnectivity(): void {
  unreachable = false;
  offline = false;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  pollDelay = FIRST_POLL;
  listeners.clear();
  readFromCache.clear();
  noteListeners.clear();
}
