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
/** When the app last went offline — at load, if it started that way. See the reconnect. */
let offlineSince = offline ? Date.now() : Infinity;
/** Requests failing while the browser believes it is online. */
let unreachable = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === offline) return;
  offline = next;
  if (next) offlineSince = Date.now();
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
 * Right after the browser says the network is back, the first ask comes much sooner.
 *
 * `online` fires when the operating system has a network, which on a phone leaving
 * airplane mode is a moment before the radio carries anything. The refetch that event
 * starts can land in that moment and fail, which puts the app straight back offline —
 * and with the ordinary twenty seconds before the next ask, someone who had just turned
 * the network back on watched the banner sit there. Within half a minute of the event,
 * the first ask is three seconds out instead.
 */
const QUICK_POLL = 3_000;
const QUICK_WINDOW = 30_000;
let onlineAt = -Infinity;

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
  const delay = pollDelay === FIRST_POLL && Date.now() - onlineAt < QUICK_WINDOW ? QUICK_POLL : pollDelay;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    pollDelay = Math.min(pollDelay * 2, LAST_POLL);
    void probe();
  }, delay);
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
 * On the way back, what was read during the outage is fetched again even if React Query
 * thinks it fresh: it may have come from the worker's cache, and be older than the thirty
 * seconds that would otherwise protect it — which is also what lets a note opened from the
 * cache be edited again (see `Workspace`). So is anything that failed during it, like a
 * note that was not available offline. Everything read before the outage came from the
 * server and is left to React Query's own staleness, which refetches it on reconnect once
 * it is older than thirty seconds and not before. Invalidating everything instead refetched
 * every loaded page of a long list on every flip of a patchy connection, and rows read are
 * the production budget.
 */
export function installConnectivity(queryClient: QueryClient): void {
  window.addEventListener('online', () => {
    // The browser says the network is back; trust it until a request says otherwise, and
    // if one does, ask again soon (`QUICK_POLL`).
    onlineAt = Date.now();
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
    if (was && !offline) {
      const since = offlineSince;
      void queryClient.invalidateQueries({
        predicate: ({ state }) => state.dataUpdatedAt >= since || state.errorUpdatedAt >= since,
      });
    }
    was = offline;
  });
}

/** Test seam: back to a browser that is online, with nothing failing and nothing polling. */
export function resetConnectivity(): void {
  unreachable = false;
  offline = false;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  pollDelay = FIRST_POLL;
  onlineAt = -Infinity;
  offlineSince = Infinity;
  listeners.clear();
}
