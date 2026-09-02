import { useCallback, useSyncExternalStore, type KeyboardEvent } from 'react';

/**
 * Arrow-key navigation for a list of links.
 *
 * Kept in the DOM rather than in React state. The sidebar's list is three sources at once
 * — the paged note list, search results, and the trash — plus a "Load more" button sitting
 * in the same `ul`, and the rendered order is the only place those agree. Asking the DOM
 * for "the next `.note-item`" is therefore both simpler and harder to get wrong than
 * threading an index through every caller, and it cannot drift out of sync with what is
 * actually on screen.
 *
 * Moving focus is all this does. The entries are real links, so focusing one and pressing
 * Enter already navigates — this adds no routing of its own, and inherits middle-click,
 * copy-link-address and the browser's own focus ring for free.
 */
/**
 * Whether the note on screen was reached with the arrow keys.
 *
 * A module-level flag rather than router state or a context. It answers a question about
 * the last input device, not about the application — it is deliberately not in the URL,
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
   Any pointer press ends the keyboard's claim on focus.

   Without this, arrowing to a note and then clicking a different one left the flag set,
   so the click opened a note whose editor refused to focus — the arrow keys' rule
   outliving the arrow keys. Captured at the document, before the click reaches the link,
   so the flag is already false by the time the new editor mounts.
*/
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => setCameFromList(false), true);
}

export function useListKeys() {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') {
      return;
    }

    // Only when an entry has focus. Arrows inside the filter box or the "Load more"
    // button belong to those controls, and stealing them would break text editing.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.classList.contains('note-item')) return;

    /*
       Enter commits: it hands the note over to be written in.

       The link is already on the right note — arrowing opened it — so this is a focus
       move, not a navigation. It is what separates the two modes: arrows browse, Enter
       edits, and without it the only way out of the list is the mouse or a Tab through
       whatever sits between.
    */
    if (event.key === 'Enter') {
      event.preventDefault();
      setCameFromList(false);
      focusEditor();
      return;
    }

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('.note-item'),
    );
    const index = items.indexOf(active);
    if (index === -1) return;

    const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)];
    // At either end, let the key through: on a long list the browser scrolling the
    // sidebar is more useful than the selection refusing to move with no explanation.
    if (!next) return;

    event.preventDefault();
    // Set before the click so the workspace's editor sees it during the mount it triggers.
    setCameFromList(true);
    next.focus();
    // The entry is a link, so focusing it is not opening it. Click is what navigates,
    // and it carries the router's own handling of the search params the list is scoped to.
    next.click();
  }, []);
}

/**
 * Hands focus to the editor, at the end of the note.
 *
 * The workspace registers the real implementation when its view mounts; until then this
 * is a no-op, which is the correct behaviour for an Enter pressed before an editor
 * exists. A registration rather than a prop chain because the list and the editor are
 * siblings under a route, with the whole layout between them.
 */
let focusEditorImpl: (() => void) | null = null;

export function registerEditorFocus(fn: (() => void) | null) {
  focusEditorImpl = fn;
}

function focusEditor() {
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
  const active = document.querySelector<HTMLElement>('.note-item.active');
  if (!active) return false;
  setCameFromList(true);
  active.focus();
  // Focus is the proof, not the query: on a phone the sidebar is display:none, and a
  // hidden element silently refuses focus rather than throwing. Asking what actually took
  // it covers that without a visibility test of its own — which `offsetParent` could not
  // give honestly anyway, since jsdom reports null for every element.
  return document.activeElement === active;
}
