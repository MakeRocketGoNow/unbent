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

/**
 * Listens for history moves. Installed once, before the router, so the flag is set by the
 * time the router decides how the move is drawn.
 */
export function watchHistoryMoves(): void {
  window.addEventListener('popstate', (e) => {
    const flagged = (e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
    const swipe = hostApp()?.platform === 'ios';
    pop = { key: (e.state as { __TSR_key?: string } | null)?.__TSR_key, drawn: flagged || swipe };
  });
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
  const key = (toLocation.state as { __TSR_key?: string }).__TSR_key;
  if (popped?.drawn && popped.key === key) return false;
  if (!fromLocation || !window.matchMedia(MOBILE_QUERY).matches) return false;
  const slide = slideFor(fromLocation.pathname, toLocation.pathname, indexOf(toLocation) < indexOf(fromLocation));
  return slide ? [slide] : false;
}

/**
 * Whether the browser can tell a transition's types apart. Without that the router would
 * run every navigation as one untyped transition, which the stylesheet draws as a
 * crossfade of the whole page — for a filter change as much as for opening a note. Such a
 * browser gets no transitions instead.
 */
export function canTypeTransitions(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports?.('selector(:active-view-transition-type(a))') === true;
}
