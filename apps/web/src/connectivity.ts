import { useSyncExternalStore } from 'react';
import { onlineManager, type QueryClient } from '@tanstack/react-query';

/**
 * Whether the app can reach its server right now — the one answer the offline banner, the
 * faded controls, the outbox's replay and React Query's pausing all read, so they cannot
 * disagree.
 *
 * The rule is evidence over hints. The app is offline while the server is out of reach:
 * the last check of it (`GET /api/health`, with a timeout, any HTTP answer counting) got
 * no answer, or the browser fired `offline` and nothing has answered since. It is back
 * the moment the server answers anything — a check, or any request the API client made
 * that the server itself answered (`confirmReachable`, called from `request` for an
 * answer the service worker did not serve from a cache or the device's shelves). A real
 * answer is the strongest evidence of a connection there is, and nothing is allowed to
 * outrank it.
 *
 * The browser's `navigator.onLine` is a hint, never a veto. It is read at start and its
 * events are heard, and each starts a check — the `offline` event puts the banner up at
 * once, since airplane mode should not wait twenty seconds for a check to time out. But
 * it decides nothing on its own. Until 2026-10-13 it did: while it said offline, no check
 * was ever made, so a browser that was wrong — a laptop on a VPN, where Chrome reported no
 * network while every request succeeded — left the banner up for good, with every
 * successful request on screen in the Network tab, refusing saves on a machine with a
 * perfect connection, until the next `online` event. MDN documents the property as
 * unreliable, and the outbox library's own detector refuses to trust it in a visible tab;
 * this store had replaced that detector and lost the guard.
 *
 * The earlier design, where any failed request put the app offline and any answer put it
 * back, is not what this returns to. A kept file answers with no network, and a save on
 * a connection that carries nothing fails with one; those still only ask for a check.
 * What changed is that an answer the server gave is taken for what it is.
 *
 * Deliberately free of the router and of the page's own modules, so the API client and
 * the session check can call into it without importing either.
 */

/** Why the app believes what it does, for Settings → Offline and the console. */
export interface ConnectivityReport {
  offline: boolean;
  /** `navigator.onLine` as the browser reports it now; false here with `offline` false is the browser being wrong. */
  browserOnLine: boolean;
  /** What last decided the answer, and when. */
  decided: { by: 'start' | 'answer' | 'check' | 'browser'; at: number };
  /** The last check of the server, if one has run. */
  lastCheck: { at: number; reached: boolean; ms: number } | null;
}

/** The server is out of reach: the one state, and the whole of what `offline` means. */
let unreachable = typeof navigator !== 'undefined' && navigator.onLine === false;
let offline = unreachable;
let decided: ConnectivityReport['decided'] = { by: 'start', at: Date.now() };
let lastCheck: ConnectivityReport['lastCheck'] = null;
/** When the server last answered a request of the page's, for a check that fails after it. */
let answeredAt = -Infinity;
/**
 * When the current doubt began — the first failed request, the browser going offline —
 * or `Infinity` when there is none. What was read or failed since then is fetched again
 * once the server is confirmed (`recover`).
 */
let doubtSince = offline ? Date.now() : Infinity;
const listeners = new Set<() => void>();
const reportListeners = new Set<() => void>();
let recover: (since: number) => void = () => {};

function set(next: boolean): void {
  if (next === offline) return;
  offline = next;
  console.info(`[connectivity] ${offline ? 'offline' : 'online'}: decided by ${decided.by}`);
  for (const listener of listeners) listener();
}

function browserOnLine(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function decide(by: ConnectivityReport['decided']['by'], reachable: boolean): void {
  unreachable = !reachable;
  decided = { by, at: Date.now() };
  evaluate();
}

function evaluate(): void {
  const was = offline;
  set(unreachable);
  if (was && !offline) endDoubt();
  schedulePoll();
  report = null;
  for (const listener of reportListeners) listener();
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

let report: ConnectivityReport | null = null;

/** Why the app believes what it does; the same object until something changes. */
export function connectivityReport(): ConnectivityReport {
  report ??= { offline, browserOnLine: browserOnLine(), decided, lastCheck };
  return report;
}

export function useConnectivityReport(): ConnectivityReport {
  return useSyncExternalStore(
    (listener) => {
      reportListeners.add(listener);
      return () => void reportListeners.delete(listener);
    },
    connectivityReport,
    connectivityReport,
  );
}

/**
 * The server answered a request the page made — not a cache, not the device. Online at
 * once, whatever the browser says. A check still in flight that fails afterwards is
 * ignored (`check`): the answer is newer than the question.
 */
export function confirmReachable(): void {
  answeredAt = Date.now();
  if (!unreachable && doubtSince === Infinity) return;
  decide('answer', true);
  // A doubt the server has answered without the app ever going offline — one request
  // failed and the next did not — still leaves that request's query failed, so it ends
  // here too.
  endDoubt();
}

/** How long a check may take before it counts as no answer. */
const CHECK_TIMEOUT = 10_000;
/** The least time between two checks, so a page of kept images asks once, not twenty times. */
const MIN_GAP = 3_000;
let checking = false;
let lastAsked = -Infinity;

/**
 * Something happened that the current answer may be wrong about; ask the server.
 *
 * One check at a time, and not more often than `MIN_GAP`. Asked even while the browser
 * says it is offline: on a device that really has no network the request fails at once
 * and costs nothing, and on one where the browser is wrong it is the only way back.
 */
export function recheck(): void {
  if (doubtSince === Infinity) doubtSince = Date.now();
  if (checking || Date.now() - lastAsked < MIN_GAP) return;
  void check();
}

async function check(): Promise<void> {
  checking = true;
  const started = Date.now();
  lastAsked = started;
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
  lastCheck = { at: Date.now(), reached, ms: Date.now() - started };
  // The server answered something else while this check was waiting: that answer stands.
  if (!reached && answeredAt >= started) {
    evaluate();
    return;
  }
  if (reached && !offline) endDoubt();
  decide('check', reached);
}

const FIRST_POLL = 20_000;
const LAST_POLL = 5 * 60_000;
let pollDelay = FIRST_POLL;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Right after the browser says the network changed, the next ask comes much sooner.
 *
 * `online` fires when the operating system has a network, which on a phone leaving
 * airplane mode is a moment before the radio carries anything. The check that event starts
 * can land in that moment and fail; within half a minute of the event, the next is three
 * seconds out instead of twenty. The same after `offline`, which is as often a VPN or an
 * interface flapping as it is a real loss: the banner goes up at once, and if the server is
 * there after all it comes down in seconds rather than twenty.
 */
const QUICK_POLL = 3_000;
const QUICK_WINDOW = 30_000;
let changedAt = -Infinity;

/**
 * While the server is out of reach, nothing else would ever ask, so the store keeps asking:
 * twenty seconds, doubling to five minutes. Whatever the browser says about the network.
 */
function schedulePoll(): void {
  if (!unreachable) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    pollDelay = FIRST_POLL;
    return;
  }
  if (pollTimer !== undefined) return;
  const delay = pollDelay === FIRST_POLL && Date.now() - changedAt < QUICK_WINDOW ? QUICK_POLL : pollDelay;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    pollDelay = Math.min(pollDelay * 2, LAST_POLL);
    lastAsked = -Infinity;
    recheck();
  }, delay);
}

/** The browser's `online` or `offline`: a hint that starts a quick check. */
function networkChanged(): void {
  changedAt = Date.now();
  lastAsked = -Infinity;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  pollDelay = FIRST_POLL;
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
    networkChanged();
    recheck();
  });
  // The browser says the network went. Believed at once, so airplane mode shows the banner
  // the moment it is switched on — and checked at once, so a browser that is wrong about
  // it is found out in seconds.
  window.addEventListener('offline', () => {
    networkChanged();
    if (doubtSince === Infinity) doubtSince = Date.now();
    decide('browser', false);
    recheck();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && unreachable) recheck();
  });

  onlineManager.setEventListener((setOnline) => {
    setOnline(!offline);
    return subscribeConnectivity(() => setOnline(!offline));
  });

  // A page that started with the browser saying offline: the poll asks the server, and
  // the first request the page makes will answer for it sooner.
  if (unreachable) {
    decided = { by: 'browser', at: Date.now() };
    schedulePoll();
  }
}

/** Test seam: the answer a check would give, without one. */
export function setReachableForTests(reachable: boolean): void {
  if (!reachable && doubtSince === Infinity) doubtSince = Date.now();
  if (reachable && !offline) endDoubt();
  decide('check', reachable);
}

/** Test seam: back to a browser that is online, with nothing failing and nothing polling. */
export function resetConnectivity(): void {
  unreachable = false;
  offline = false;
  decided = { by: 'start', at: Date.now() };
  lastCheck = null;
  answeredAt = -Infinity;
  doubtSince = Infinity;
  checking = false;
  lastAsked = -Infinity;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  pollDelay = FIRST_POLL;
  changedAt = -Infinity;
  recover = () => {};
  listeners.clear();
  reportListeners.clear();
  report = null;
}
