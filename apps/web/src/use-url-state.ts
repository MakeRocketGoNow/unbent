import { useCallback, useSyncExternalStore } from 'react';

/**
 * App state that lives in the URL.
 *
 * This module is the *only* place in the web app that touches `URLSearchParams` or the
 * history API. Every consumer goes through `useUrlState`, so the choice of query params
 * over path routes is an implementation detail of this file — swapping in a router later
 * rewrites this module and nothing else. A test in `use-url-state.test.ts` enforces that
 * boundary, because an abstraction like this erodes silently once it is bypassed once.
 *
 * Param names deliberately match the API's query parameters (`notebook`, `tag`, `q`) so
 * filters pass straight through to `notes-api.ts` with no translation layer.
 */

export interface UrlState {
  /** Notebook scope, or null for all notebooks. */
  notebook: string | null;
  /** Tag filter, or null for unfiltered. */
  tag: string | null;
  /** Id of the open note, or null when none is selected. */
  note: string | null;
  /** Search query. Empty string means "not searching". */
  q: string;
}

export interface SetOptions {
  /**
   * Replace the current history entry instead of pushing a new one.
   *
   * Used for search-as-you-type: the query updates on every keystroke, and pushing would
   * bury the previous page under one entry per character.
   */
  replace?: boolean;
}

/** Params this module owns. Anything else in the query string is preserved untouched. */
const KEYS = ['notebook', 'tag', 'note', 'q'] as const;

export function parse(search: string): UrlState {
  const params = new URLSearchParams(search);
  return {
    notebook: params.get('notebook') || null,
    tag: params.get('tag') || null,
    note: params.get('note') || null,
    q: params.get('q') ?? '',
  };
}

/**
 * Subscribers to URL changes.
 *
 * `history.pushState` and `replaceState` do not fire `popstate` — that event only fires for
 * user-driven navigation like the Back button. So writes have to notify listeners directly,
 * or the UI would not react to its own navigation.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('popstate', onChange);
  };
}

/** The subscription used by `useSyncExternalStore`, exposed so tests can observe emits. */
export const subscribeForTest = subscribe;

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Cached snapshot.
 *
 * `useSyncExternalStore` requires `getSnapshot` to return a referentially stable value
 * while the underlying store is unchanged; returning a fresh object each call would loop
 * forever. The cache is keyed on the raw search string.
 */
let cachedSearch: string | null = null;
let cachedState: UrlState = { notebook: null, tag: null, note: null, q: '' };

function getSnapshot(): UrlState {
  const search = window.location.search;
  if (search !== cachedSearch) {
    cachedSearch = search;
    cachedState = parse(search);
  }
  return cachedState;
}

/**
 * Builds the next URL, dropping empty values so cleared filters leave no trace.
 *
 * Pure: `pathname` and `search` are passed in rather than read from `window`, which is what
 * lets the interesting behaviour be unit-tested without a DOM.
 */
export function nextUrl(
  patch: Partial<UrlState>,
  pathname: string,
  search: string,
): string {
  const params = new URLSearchParams(search);

  for (const key of KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    // Null and '' both mean "not set". Writing them would leave `?tag=&q=` in the bar.
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Applies a patch to the URL and notifies subscribers.
 *
 * Exported so tests drive the real write path rather than a reimplementation of it — a
 * test that rebuilds this logic passes happily while the shipped version is broken.
 */
export function writeUrl(patch: Partial<UrlState>, opts: SetOptions = {}): void {
  const url = nextUrl(patch, window.location.pathname, window.location.search);
  // A no-op write would still add a history entry, making Back appear stuck.
  if (url === `${window.location.pathname}${window.location.search}`) return;

  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  emit();
}

/**
 * Reads and writes the URL-backed app state.
 *
 * Reading is via `useSyncExternalStore` rather than `useState` + `useEffect`: the browser's
 * history is an external mutable source, and this is the case that API exists for. It also
 * avoids the StrictMode double-effect hazard a mount-time sync would have.
 */
export function useUrlState(): UrlState & {
  set: (patch: Partial<UrlState>, opts?: SetOptions) => void;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const set = useCallback(writeUrl, []);

  return { ...state, set };
}
