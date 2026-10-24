import { useCallback, useSyncExternalStore, type KeyboardEvent } from 'react';

/**
 * Arrow-key navigation for the sidebar's list.
 *
 * Kept in the DOM rather than in React state. The sidebar's list is three sources at once
 * (the paged note list, search results, and the trash) plus a "Load more" button sitting
 * in the same `ul`, and the rendered order is the only place those agree. Asking the DOM
 * for "the next row" is therefore both simpler and harder to get wrong than threading an
 * index through every caller, and it cannot drift out of sync with what is actually on
 * screen.
 *
 * Two kinds of row. A note entry is a link: arrowing onto it opens it, because browsing
 * is what the arrows are for, and Enter then hands the note over to be written in. A
 * search pick (a tag or a notebook offered above the results) is a button: arrowing
 * onto it only focuses it, since applying a filter is a commitment a glance should not
 * make, and Enter is the button's own. Both are real controls, so the browser's focus
 * ring, middle-click and copy-link-address come for free and this adds no routing.
 *
 * The list is entered from the search field with Arrow Down and left from its first row
 * with Arrow Up (`enterList` and `onLeaveTop`), so a search is one keyboard path from
 * the first keystroke to the note: type, arrow into the picks and the results, Enter.
 * That is Apple Notes' and Finder's shape rather than a combobox's, because the results
 * are the list under the field, not a menu of their own.
 *
 * A list drawn as cards (`data-grid` on it) is a grid, and its arrows are a grid's, as in
 * Finder's icon view and every photo app: Left and Right step through the cards in order,
 * wrapping from a row's end to the next row's start, and Up and Down go to the card above
 * or below, the nearest one to where the focus is across the row. Above and below are
 * read from where the cards are drawn, not counted from a column number, since the
 * column count is whatever `auto-fill` made of the width and the rows can hold a search's
 * picks, a full-width row of their own.
 */

/**
 * The rows the arrows move between, in the order they are on screen. A note is a sidebar
 * entry or a table row's name link: the list drawn two ways, browsed by one set of keys.
 * Not the copy of a row that has just left the list, which stays drawn while it closes up
 * (`list-motion.ts`): it is not a row any more.
 */
const ROW = ':is(.scope-match-btn, .note-item, .note-row-link):not(.note-ghost *)';

function isNote(el: HTMLElement): boolean {
  return el.classList.contains('note-item') || el.classList.contains('note-row-link');
}

/** Moves to a row: a note is opened as it is reached, a pick is only focused. */
function reach(row: HTMLElement) {
  if (isNote(row)) {
    // Set before the click so the workspace's editor sees it during the mount it triggers.
    setCameFromList(true);
    row.focus();
    // The entry is a link, so focusing it is not opening it. Click is what navigates,
    // and it carries the router's own handling of the search params the list is scoped to.
    row.click();
  } else {
    row.focus();
  }
}

/**
 * Enters the list from above (the search field's Arrow Down) on its first row.
 * Returns whether there was one to land on.
 */
export function enterList(list: HTMLElement | null): boolean {
  const first = list?.querySelector<HTMLElement>(ROW);
  if (!first) return false;
  reach(first);
  return true;
}
/**
 * Whether the note on screen was reached with the arrow keys.
 *
 * A module-level flag rather than router state or a context. It answers a question about
 * the last input device, not about the application: it is deliberately not in the URL,
 * because arrowing to a note and opening that same URL in a new tab should not behave
 * differently. Read by the workspace to decide whether the editor may take focus.
 */
let cameFromList = false;
const subscribers = new Set<() => void>();

function setCameFromList(next: boolean) {
  if (cameFromList === next) return;
  cameFromList = next;
  for (const fn of subscribers) fn();
}

/** Subscribes to the flag above; see `cameFromList`. */
export function useCameFromList(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => cameFromList,
    () => false,
  );
}

/*
   A pointer press sets the flag from where it landed.

   Clicking a note in a side-by-side list is browsing, the same as arrowing to it: focus
   stays on the row and the editor stands down, so the arrows keep working and the note
   opens to be read, not written in. So a press inside such a row *sets* the flag, exactly
   as `reach` does for the keyboard. Every other press clears it: the editor, the New
   button, a row in a list that is about to replace itself with the note (a phone, where
   there is no list left to keep focus on). So those still open ready to type.

   The row marks itself with `data-keep-focus` when it is one whose list survives the open;
   see `NoteListItem`, and the table's `<tr>`, whose whole width opens the note. Captured
   at the document, before the press reaches the link, so the flag is already right by
   the time the new editor mounts.
*/
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const row =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>('.note-item, .note-row')
          : null;
      setCameFromList(row?.hasAttribute('data-keep-focus') ?? false);
    },
    true,
  );
}

export function useListKeys(opts: {
  /** Arrow Up on the first row: where focus goes instead, when the list has something above it. */
  onLeaveTop?: () => void;
} = {}) {
  const { onLeaveTop } = opts;
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const grid = event.currentTarget.hasAttribute('data-grid');
      const sideways = grid && (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && !sideways) {
        return;
      }

      // Only when a row has focus. Arrows inside the filter box or the "Load more"
      // button belong to those controls, and stealing them would break text editing.
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.matches(ROW)) return;

      /*
         Enter on a note commits: it hands the note over to be written in.

         The link is already on the right note (arrowing opened it), so this is a focus
         move, not a navigation. It is what separates the two modes: arrows browse, Enter
         edits, and without it the only way out of the list is the mouse or a Tab through
         whatever sits between. Enter on a pick presses it, which a button does on its own,
         but said here so the list's Enter means one thing on every row rather than
         depending on which element happens to carry the focus.
      */
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!isNote(active)) {
          active.click();
          return;
        }
        setCameFromList(false);
        focusEditor();
        return;
      }

      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ROW));
      const index = items.indexOf(active);
      if (index === -1) return;

      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const next =
        grid && !sideways ? across(items, active, forward) : items[index + (forward ? 1 : -1)];
      if (!next) {
        // Up from the first row goes back to the field the list was entered from.
        if (event.key === 'ArrowUp' && onLeaveTop) {
          event.preventDefault();
          onLeaveTop();
        }
        // Otherwise let the key through: on a long list the browser scrolling the sidebar
        // is more useful than the selection refusing to move with no explanation.
        return;
      }

      event.preventDefault();
      reach(next);
    },
    [onLeaveTop],
  );
}

/**
 * The card above or below `from` in a grid: of the cards on the nearest row in that
 * direction, the one whose middle is closest to `from`'s. A row is the cards sharing a
 * top edge, give or take a pixel of rounding.
 */
function across(items: HTMLElement[], from: HTMLElement, down: boolean): HTMLElement | undefined {
  const here = from.getBoundingClientRect();
  const middle = (r: DOMRect) => r.left + r.width / 2;
  const placed = items.map((el) => ({ el, rect: el.getBoundingClientRect() }));
  const beyond = placed.filter(({ rect }) => (down ? rect.top > here.top + 1 : rect.top < here.top - 1));
  if (beyond.length === 0) return undefined;
  const rowTop = down
    ? Math.min(...beyond.map(({ rect }) => rect.top))
    : Math.max(...beyond.map(({ rect }) => rect.top));
  const row = beyond.filter(({ rect }) => Math.abs(rect.top - rowTop) <= 1);
  let best = row[0]!;
  for (const c of row) {
    if (Math.abs(middle(c.rect) - middle(here)) < Math.abs(middle(best.rect) - middle(here))) best = c;
  }
  return best.el;
}

/**
 * Hands focus to the editor, at the end of the note.
 *
 * The workspace registers the real implementation when its view mounts; until then this
 * is a no-op, which is the correct behaviour for an Enter pressed before an editor
 * exists. A registration rather than a prop chain because the list and the editor are
 * siblings under a route, with the whole layout between them.
 *
 * Two callers press it: the list's Enter and the title field's. Both mean "done choosing,
 * let me write", so both should land in the same place rather than each growing a way into
 * the editor of its own.
 */
let focusEditorImpl: (() => void) | null = null;

export function registerEditorFocus(fn: (() => void) | null) {
  focusEditorImpl = fn;
}

export function focusEditor() {
  focusEditorImpl?.();
}

/**
 * Puts focus back on the open note in the sidebar.
 *
 * Found by the class the router's `activeProps` already sets, so there is no second
 * record of which entry is selected to keep in step. Returns whether it found one: on a
 * phone the sidebar is off screen, and Escape should then do nothing rather than focus
 * something invisible.
 */
export function focusActiveListItem(): boolean {
  const active = document.querySelector<HTMLElement>(':is(.note-item.active, .note-row-link.active):not(.note-ghost *)');
  if (!active) return false;
  setCameFromList(true);
  active.focus();
  // Focus is the proof, not the query: on a phone the sidebar is display:none, and a
  // hidden element silently refuses focus rather than throwing. Asking what actually took
  // it covers that without a visibility test of its own, which `offsetParent` could not
  // give honestly anyway, since jsdom reports null for every element.
  return document.activeElement === active;
}
