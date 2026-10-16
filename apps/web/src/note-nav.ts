import type { ParsedLocation } from '@tanstack/react-router';
import { hostApp } from './app-bridge.js';
import { MOBILE_QUERY } from './useMediaQuery.js';

/**
 * Moving between a list of notes and one note, on a phone: which way the screen slides.
 *
 * On a phone the note replaces the list, so opening one is a step deeper and closing it a
 * step back, and the motion says so the way every list-and-detail app on a phone does: the
 * note slides in from the right over the list, and back slides it off again. Decided here,
 * from where the navigation left and where it arrived, rather than by the control that
 * started it, because most ways in and out are not a tap on a row: a new note, a search
 * result, the trash, a link inside a note, Android's Back, a browser's back button. Each
 * gets the same slide for the same move without knowing about it.
 *
 * It replaced a container transform, Keep's, that grew the tapped row into the note and
 * shrank the note back into it. That reads in Keep because a card is a small copy of its
 * note; a row here is a title and a line, so the growth was a strip stretching into a
 * page, and in a direction that depended on where the row sat. And it needed the row: a
 * row marked on tap, so any other way in left the mark on whichever row was tapped last,
 * and Back shrank a note into a row that was not its own.
 */

/** A list of notes: the notes view or the trash, whatever filters it carries. */
export function isListPath(pathname: string): boolean {
  return /^\/(notes|trash)\/?$/.test(pathname);
}

/** One note, open: in the notes view or in the trash. */
export function isNotePath(pathname: string): boolean {
  return /^\/(notes|trash)\/[^/]+\/?$/.test(pathname);
}

/** The direction a move between a list and a note slides, or none for every other move. */
export type NoteTransition = 'note-open' | 'note-close';

/**
 * Which slide a move makes, from where it left and where it arrived.
 *
 * Into a note from a list is a step in; out to a list is a step back, whichever of the
 * history's directions took it there, since Back and the arrow both mean leaving the note.
 * Note to note, by a link in one, follows the history: forward is a step in, back is a
 * step back. Nothing else slides, and nothing does on a desktop, where the list and the
 * note sit side by side and there is no screen to replace.
 *
 * `back` says whether the history moved backwards to arrive; it only decides note to note.
 */
export function slideFor(from: string, to: string, back: boolean): NoteTransition | null {
  if (from === to) return null;
  if (isListPath(from) && isNotePath(to)) return 'note-open';
  if (isNotePath(from) && isListPath(to)) return 'note-close';
  if (isNotePath(from) && isNotePath(to)) return back ? 'note-close' : 'note-open';
  return null;
}

/*
 * The last history move the page did not make itself, and whether something has already
 * animated it.
 *
 * A swipe from the edge in Safari, and in the iOS app (`allowsBackForwardNavigationGestures`),
 * slides the previous page in under the finger before the page hears anything. Sliding it
 * again once `popstate` arrives would play the move twice, the second time from a page
 * already standing where it should. The event says when a browser has drawn its own
 * transition (`hasUAVisualTransition`). The iOS app is taken at its word without it: there
 * every history move the page does not start is that swipe, and a WebKit that does not set
 * the flag would otherwise get both.
 *
 * Keyed by the history entry the move arrived at, so the flag answers for that move and no
 * later one; consumed by the first navigation that asks.
 */
let pop: { key: string | undefined; drawn: boolean } | null = null;

/** Set while the page's own back arrow is walking the history, which nothing has drawn. */
let pageBack = false;

/**
 * Listens for history moves. Installed once, before the router, so the flag is set by the
 * time the router decides how the move is drawn.
 */
export function watchHistoryMoves(): void {
  window.addEventListener('popstate', (e) => {
    const flagged = (e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
    const swipe = hostApp()?.platform === 'ios' && !pageBack;
    pageBack = false;
    pop = { key: keyOf(e.state), drawn: flagged || swipe };
  });
}

/** The key the router gives each history entry, unique to it. */
function keyOf(state: unknown): string | undefined {
  return (state as { __TSR_key?: string } | null | undefined)?.__TSR_key;
}

/*
 * What is behind each history entry: the page the history goes back to from it, by the
 * entry's key.
 *
 * The note's back arrow needs to know whether that is the list. If it is, the arrow goes
 * back, so the history holds list then note and nothing more, and a swipe back or
 * Android's Back after it leaves the app rather than reopening the note, which is what
 * the arrow did when it opened the list as a new page on top. A history entry cannot be
 * asked what precedes it, so each navigation writes it down: a step forward puts the
 * page it left behind the page it arrived at, and a replacement keeps what was behind the
 * page it replaced, which is how a new note (made at `/notes?new=1`, then replaced by
 * the note) still has the list behind it.
 *
 * Kept in the tab's session storage, so it survives a reload, which a phone does to a
 * page in the background more often than anyone notices. Bounded, since a session can
 * walk through any number of pages.
 */
const BEHIND_KEY = 'unbent.behind';
const BEHIND_KEPT = 200;

function loadBehind(): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(BEHIND_KEY);
    const entries = raw ? (JSON.parse(raw) as [string, string][]) : [];
    return new Map(Array.isArray(entries) ? entries : []);
  } catch {
    return new Map();
  }
}

function saveBehind(behind: Map<string, string>): void {
  try {
    sessionStorage.setItem(BEHIND_KEY, JSON.stringify([...behind]));
  } catch {
    // A full or refused storage costs only the history walk: the arrow replaces instead.
  }
}

/**
 * Writes down what is behind the entry a navigation arrived at. Pure over the map, so the
 * three cases can be tested without a router.
 */
export function recordBehind(
  behind: Map<string, string>,
  from: ParsedLocation | undefined,
  to: ParsedLocation,
): void {
  const toKey = keyOf(to.state);
  if (!from || !toKey) return;
  const fromIndex = indexOf(from);
  const toIndex = indexOf(to);
  if (toIndex === fromIndex + 1) {
    behind.delete(toKey);
    behind.set(toKey, from.pathname);
  } else if (toIndex === fromIndex) {
    // The entry replaced is gone from the history, so its line goes too: a search typed
    // into the list replaces the entry on every keystroke, and each gets a key of its own.
    const fromKey = keyOf(from.state) ?? '';
    const kept = behind.get(fromKey);
    behind.delete(fromKey);
    behind.delete(toKey);
    if (kept !== undefined) behind.set(toKey, kept);
  }
  // Anything else walked the history to an entry already written down.
  // Oldest first, since every line is written last: what is let go is what Back reaches last.
  while (behind.size > BEHIND_KEPT) behind.delete(behind.keys().next().value!);
}

let behind: Map<string, string> | null = null;

/** Follows the router's navigations to keep `behind` current. Installed once. */
export function trackWhatIsBehind(router: {
  subscribe: (type: 'onResolved', fn: (e: { fromLocation?: ParsedLocation; toLocation: ParsedLocation }) => void) => unknown;
}): void {
  behind = loadBehind();
  router.subscribe('onResolved', ({ fromLocation, toLocation }) => {
    if (!behind) return;
    recordBehind(behind, fromLocation, toLocation);
    saveBehind(behind);
  });
}

/** As much of the router's history as the arrow uses: where it is, and the way back. */
export interface RouterHistoryLike {
  history: { location: { state: unknown }; back: () => void };
}

/**
 * The note's back arrow, when the list it leads to is the page behind this one: goes back
 * to it through the router's history and says so, so the arrow's link stands down.
 * Otherwise false, and the link replaces the note with the list: a note opened from a
 * link, a notification or another note has something else behind it, or nothing.
 */
export function goBackToList(router: RouterHistoryLike, list: string): boolean {
  const here = keyOf(router.history.location.state);
  const previous = here ? behind?.get(here) : undefined;
  if (previous?.replace(/\/$/, '') !== list) return false;
  pageBack = true;
  router.history.back();
  return true;
}

/** The index the router keeps on each history entry, to tell forward from back. */
function indexOf(location: ParsedLocation | undefined): number {
  return (location?.state as { __TSR_index?: number } | undefined)?.__TSR_index ?? 0;
}

/**
 * The router's `defaultViewTransition` types: the view-transition type a navigation runs
 * with, or `false` for none, which is the router's way of saying "no transition at all".
 */
export function noteTransitionTypes({
  fromLocation,
  toLocation,
}: {
  fromLocation?: ParsedLocation;
  toLocation: ParsedLocation;
}): string[] | false {
  const popped = pop;
  pop = null;
  if (popped?.drawn && popped.key === keyOf(toLocation.state)) return false;
  if (!fromLocation || !window.matchMedia(MOBILE_QUERY).matches) return false;
  const slide = slideFor(fromLocation.pathname, toLocation.pathname, indexOf(toLocation) < indexOf(fromLocation));
  return slide ? [slide] : false;
}

/**
 * Whether the browser can tell a transition's types apart. Without that the router would
 * run every navigation as one untyped transition, which the stylesheet draws as a
 * crossfade of the whole page, for a filter change as much as for opening a note. Such a
 * browser gets no transitions instead.
 */
export function canTypeTransitions(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports?.('selector(:active-view-transition-type(a))') === true;
}

/**
 * The arrow's click, for its `Link`: back through the history when `goBackToList` can,
 * and the link's own navigation otherwise. A modified click is left to the link, which
 * opens the list in a new tab as any link would.
 */
export function onBackArrowClick(router: RouterHistoryLike, list: string) {
  return (e: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    preventDefault: () => void;
  }) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (goBackToList(router, list)) e.preventDefault();
  };
}
