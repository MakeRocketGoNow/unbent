import { useSyncExternalStore } from 'react';
import { onlineManager, type QueryClient } from '@tanstack/react-query';

/**
 * Whether the app can reach its server right now — the one answer the offline banner, the
 * read-only editor and React Query's pausing all read, so they cannot disagree.
 *
 * Two things decide it, and only two: the browser's `navigator.onLine`, which airplane mode
 * sets, and a check of the server — `GET /api/health`, with a timeout, counting any HTTP
 * answer (a 503 included) as the server being there. Everything else only asks for a check
 * (`recheck`): a request that got no answer, a read the service worker answered from its
 * cache, a save that timed out, any answer at all while the app believes it is offline.
 *
 * It used to let those events decide directly. A failed request put the app offline, and
 * any answer put it back. Every new way of answering then became a new way of flipping the
 * banner wrongly. A file served from the cache counted as the server being back, a slow
 * save counted as it being gone, and a stale error in the session store re-raised the
 * banner on every navigation. On a connection that is up but carries nothing — a train,
 * a captive portal — the app flickered between locked and unlocked. Only the check can
 * tell those cases apart, so only the check decides.
 *
 * Deliberately free of the router and of the page's own modules, so the API client and
 * the session check can call into it without importing either.
 */

/** The last check of the server got no answer. */
let unreachable = false;
let offline = typeof navigator !== 'undefined' ? navigator.onLine === false : false;
/**
 * When the current doubt began — the first failed request, the browser going offline —
 * or `Infinity` when there is none. What was read or failed since then is fetched again
 * once the server is confirmed (`recover`).
 */
let doubtSince = offline ? Date.now() : Infinity;
const listeners = new Set<() => void>();
let recover: (since: number) => void = () => {};

function set(next: boolean): void {
  if (next === offline) return;
  offline = next;
  for (const listener of listeners) listener();
}

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function evaluate(): void {
  const was = offline;
  set(browserOffline() || unreachable);
  if (was && !offline) endDoubt();
  schedulePoll();
}

function endDoubt(): void {
  const since = doubtSince;
  doubtSince = Infinity;
  if (since !== Infinity) recover(since);
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

/** How long a check may take before it counts as no answer. */
const CHECK_TIMEOUT = 10_000;
/** The least time between two checks, so a page of kept images asks once, not twenty times. */
const MIN_GAP = 3_000;
let checking = false;
let lastCheck = -Infinity;

/**
 * Something happened that the current answer may be wrong about; ask the server.
 *
 * Nothing is asked while the browser itself says it is offline — a request then can only
 * fail, and its `online` event says when that changes. One check at a time, and not more
 * often than `MIN_GAP`.
 */
export function recheck(): void {
  if (doubtSince === Infinity) doubtSince = Date.now();
  if (browserOffline()) {
    evaluate();
    return;
  }
  if (checking || Date.now() - lastCheck < MIN_GAP) return;
  void check();
}

async function check(): Promise<void> {
  checking = true;
  lastCheck = Date.now();
  let reached: boolean;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
  try {
    await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
    reached = true;
  } catch {
    reached = false;
  } finally {
    clearTimeout(timer);
  }
  checking = false;
  unreachable = !reached;
  // A doubt the server has answered without the app ever going offline — one request
  // failed and the next did not — still leaves that request's query failed, so it ends
  // here too.
  if (reached && !offline) endDoubt();
  evaluate();
}

const FIRST_POLL = 20_000;
const LAST_POLL = 5 * 60_000;
let pollDelay = FIRST_POLL;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Right after the browser says the network is back, the next ask comes much sooner.
 *
 * `online` fires when the operating system has a network, which on a phone leaving
 * airplane mode is a moment before the radio carries anything. The check that event starts
 * can land in that moment and fail; within half a minute of the event, the next is three
 * seconds out instead of twenty.
 */
const QUICK_POLL = 3_000;
const QUICK_WINDOW = 30_000;
let onlineAt = -Infinity;

/**
 * While the server is out of reach and the browser believes it is online, nothing else
 * would ever ask, so the store keeps asking: twenty seconds, doubling to five minutes.
 */
function schedulePoll(): void {
  if (!unreachable || browserOffline()) {
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
    lastCheck = -Infinity;
    recheck();
  }, delay);
}

/**
 * Starts listening, and makes React Query's idea of "online" this store's.
 *
 * React Query otherwise follows the browser's `online`/`offline` events alone, so a
 * connection that is up and carries nothing looked online to it forever. Here it pauses
 * retries exactly when the banner shows, and resumes them when the banner goes.
 *
 * On the way back — or when a doubt is answered without the app ever going offline — what
 * was read or failed since the doubt began is fetched again even if React Query thinks it
 * fresh: it may have come from the worker's cache, which is also what lets a note opened
 * from the cache be edited again (see `Workspace`). Everything read before came from the
 * server and is left to React Query's own staleness. Invalidating everything instead
 * refetched every loaded page of a long list on every flip, and rows read are the
 * production budget.
 */
export function installConnectivity(queryClient: QueryClient): void {
  recover = (since) =>
    void queryClient.invalidateQueries({
      predicate: ({ state }) => state.dataUpdatedAt >= since || state.errorUpdatedAt >= since,
    });

  // The browser has a network again. The server decides whether it can be reached: until
  // the check answers, the app stays as it is, rather than unlocking and relocking.
  window.addEventListener('online', () => {
    onlineAt = Date.now();
    unreachable = true;
    lastCheck = -Infinity;
    // A slow poll left from before — minutes out, after a run of failed checks — gives way
    // to the quick one, or a first check that lands before the radio is up would leave
    // the banner waiting on it.
    clearTimeout(pollTimer);
    pollTimer = undefined;
    pollDelay = FIRST_POLL;
    recheck();
  });
  window.addEventListener('offline', () => {
    if (doubtSince === Infinity) doubtSince = Date.now();
    evaluate();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && unreachable) recheck();
  });

  onlineManager.setEventListener((setOnline) => {
    setOnline(!offline);
    return subscribeConnectivity(() => setOnline(!offline));
  });
}

/** Test seam: the answer a check would give, without one. */
export function setReachableForTests(reachable: boolean): void {
  if (!reachable && doubtSince === Infinity) doubtSince = Date.now();
  unreachable = !reachable;
  if (reachable && !offline) endDoubt();
  evaluate();
}

/** Test seam: back to a browser that is online, with nothing failing and nothing polling. */
export function resetConnectivity(): void {
  unreachable = false;
  offline = false;
  doubtSince = Infinity;
  checking = false;
  lastCheck = -Infinity;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  pollDelay = FIRST_POLL;
  onlineAt = -Infinity;
  recover = () => {};
  listeners.clear();
}
