import { useCallback, type RefObject } from 'react';
import { onLocalWrite } from './store/actions.js';

/**
 * Notes leaving and arriving in a list, instead of vanishing and appearing, when the
 * person's own action is what moved them.
 *
 * Trash a note, move it out of the notebook on screen, empty the trash, Undo: the row used
 * to disappear and every row under it jump up a row's height in one frame, so the eye lost
 * its place and had to find it again. Now the row fades where it stood while the rows under
 * it slide up into its place; a row coming back fades in while the rest make room. The
 * motion says what happened — this one went, those closed up — which the jump left the
 * reader to work out.
 *
 * Only for a write made here (`onLocalWrite`). The feed brings other devices' changes and
 * the first copy brings thousands of rows; moving the list for those would set it sliding
 * under someone reading it. A list redrawn because a filter changed is not a write at all.
 *
 * The technique is FLIP, done by hand rather than with a library: where every row in the
 * list stands is measured when a write is about to land — `onLocalWrite` is heard before
 * the change reaches the rows — and once the list has redrawn, each row that moved is
 * started at its old place and let go to its new one. Transforms only, so nothing is laid
 * out again while it runs, and the list scrolls and takes clicks throughout; a view
 * transition was the other way in, and would have frozen the page for its length and drawn
 * rows outside the list's scroll box. A row that left is gone from the page by then, so a
 * copy of it is drawn where it stood and closed up (`.note-ghost`), inside the list so it
 * scrolls with the rows and is clipped where they are.
 *
 * A write whose redraw does not come within `ARMED_MS` is let go, and anything that is not
 * a change in which rows the list holds — a title retyped, a date updated — moves nothing,
 * since only the list's own children are watched.
 */

/** How long a measurement waits for the redraw it was taken for. */
const ARMED_MS = 1500;
/** Rows sliding to their new places; the curve the disclosures use. */
const MOVE_MS = 280;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** A row that came back, after the rows around it have begun to make room. */
const ARRIVE_MS = 220;
const ARRIVE_DELAY_MS = 60;

const ROWS = ':scope > [data-note-id]';

interface Snapshot {
  /** The list's own box when measured, so a list that moved as a whole moves nothing in it. */
  view: DOMRect;
  /**
   * Every row the list held and where it stood, on screen or not. A row just below the
   * fold slides up into view when one above it leaves; without its old place it would
   * jump to its new one and land on the row still sliding above it.
   */
  rows: Map<string, { rect: DOMRect; node: HTMLElement }>;
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function onScreen(rect: DOMRect, view: DOMRect): boolean {
  return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
}

function measure(list: HTMLElement): Snapshot {
  const rows = new Map<string, { rect: DOMRect; node: HTMLElement }>();
  for (const node of list.querySelectorAll<HTMLElement>(ROWS)) {
    rows.set(node.dataset.noteId!, { rect: node.getBoundingClientRect(), node });
  }
  return { view: list.getBoundingClientRect(), rows };
}

/** The colour the list is drawn on, for a leaving row's copy to cover what slides under it. */
function surfaceOf(el: HTMLElement): string {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const bg = getComputedStyle(at).backgroundColor;
    if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return 'transparent';
}

function play(list: HTMLElement, before: Snapshot): void {
  const view = list.getBoundingClientRect();
  const present = new Map<string, HTMLElement>();
  for (const node of list.querySelectorAll<HTMLElement>(ROWS)) present.set(node.dataset.noteId!, node);

  for (const [id, node] of present) {
    const was = before.rows.get(id);
    const rect = node.getBoundingClientRect();
    if (was) {
      // Where it stood in the list against where it stands now; a list that scrolled to
      // keep its place, or moved as a whole, is not a row moving. A row off screen at both
      // ends of the move is left alone: nobody would see it go.
      const dy = was.rect.top - before.view.top - (rect.top - view.top);
      const seen = onScreen(rect, view) || onScreen(was.rect, before.view);
      if (Math.abs(dy) >= 1 && seen) {
        node.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: MOVE_MS, easing: EASE });
      }
    } else if (onScreen(rect, view)) {
      node.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: ARRIVE_MS,
        delay: ARRIVE_DELAY_MS,
        easing: 'ease-out',
        fill: 'backwards',
      });
    }
  }

  let surface: string | null = null;
  for (const [id, was] of before.rows) {
    if (present.has(id) || !onScreen(was.rect, before.view)) continue;
    surface ??= surfaceOf(list);
    const ghost = was.node.cloneNode(true) as HTMLElement;
    delete ghost.dataset.noteId;
    ghost.classList.add('note-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    // In the list's own coordinates — it scrolls, and the copy is placed inside it — at
    // the place on screen the row left.
    ghost.style.top = `${was.rect.top - before.view.top - list.clientTop + list.scrollTop}px`;
    ghost.style.left = `${was.rect.left - before.view.left - list.clientLeft + list.scrollLeft}px`;
    ghost.style.width = `${was.rect.width}px`;
    ghost.style.height = `${was.rect.height}px`;
    ghost.style.background = surface;
    list.appendChild(ghost);
    /*
       Closed from the bottom on the rows' own curve and timing, so its visible edge is
       where the top of the row rising into its place is at every frame: the row under it
       pushes it shut. Fading alone, the two rows' text crossed for the length of the fade.
    */
    const fade = ghost.animate(
      [
        { clipPath: 'inset(0 0 0 0)', opacity: 1 },
        { clipPath: 'inset(0 0 100% 0)', opacity: 0 },
      ],
      { duration: MOVE_MS, easing: EASE, fill: 'forwards' },
    );
    fade.finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    );
  }
}

/**
 * Moves the list's rows for each write made here. Returns the way to stop. A `<ul>` whose
 * direct children are the rows, each carrying `data-note-id`.
 */
export function followLocalChanges(list: HTMLElement): () => void {
  let before: Snapshot | null = null;
  let timer = 0;
  const unlisten = onLocalWrite(() => {
    if (reducedMotion()) return;
    before = measure(list);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (before = null), ARMED_MS);
  });
  // The list's own children only: rows added, removed or reordered. Its copies of leaving
  // rows are children too, but by the time they are added the measurement is spent.
  const observer = new MutationObserver(() => {
    const snapshot = before;
    if (!snapshot) return;
    before = null;
    window.clearTimeout(timer);
    play(list, snapshot);
  });
  observer.observe(list, { childList: true });
  return () => {
    unlisten();
    observer.disconnect();
    window.clearTimeout(timer);
  };
}

/**
 * A ref for a note list that moves its rows for the person's own changes, filling in `ref`
 * as well for whoever else needs the element.
 */
export function useListMotion<T extends HTMLElement>(ref?: RefObject<T | null>) {
  return useCallback(
    (el: T | null) => {
      if (ref) ref.current = el;
      if (!el) return;
      const stop = followLocalChanges(el);
      return () => {
        stop();
        if (ref) ref.current = null;
      };
    },
    [ref],
  );
}
