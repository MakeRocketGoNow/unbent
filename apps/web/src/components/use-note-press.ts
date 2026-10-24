import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { RowSelection } from './NoteListItem.js';

/**
 * How long a finger rests on a row before it selects rather than opens.
 *
 * Android's own long-press timeout, and about what iOS uses: a touch that has lasted
 * this long is not a tap that is running late, it is the other gesture.
 */
const LONG_PRESS_MS = 500;

/** How far a resting finger may drift before it is a scroll and not a press. */
const PRESS_SLOP_PX = 10;

/**
 * The handlers that make a note's link take part in the list's selection: the modifier
 * clicks, the long press on touch, Space. Spread onto the `Link` of a list row and of a
 * card alike, so the two drawings of the list are selected by exactly the same rules
 * (which `NoteListItem` explains) rather than by two copies that would drift.
 *
 * Nothing where the link is only a way in (`selection` absent): a click opens the note,
 * as any link's does.
 */
export function useNotePress(selection: RowSelection | undefined) {
  /*
     The long press. A timer started on touch-down and cancelled by anything that makes
     the touch something else: lifting, drifting more than the slop, the browser taking
     the pointer for a scroll. When it fires, the row is picked and the click that follows
     the finger lifting is swallowed, since it would open the note that was just selected.
     The context menu a browser offers for a held link is swallowed for the same press:
     the press has already meant something.
  */
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const pointerType = useRef('mouse');
  const cancelPress = () => {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  };

  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      pointerType.current = e.pointerType;
      swallowClick.current = false;
      if (!selection || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return;
      cancelPress();
      const timer = window.setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        // A nudge, where the platform has one, so the finger knows the press landed.
        navigator.vibrate?.(15);
        selection.onPick({ range: false });
      }, LONG_PRESS_MS);
      press.current = { timer, x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      if (selection && (press.current || swallowClick.current)) e.preventDefault();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // Space on a link scrolls the page, which nobody focused a note row to do.
      if (selection && e.key === ' ') {
        e.preventDefault();
        selection.onPick({ range: e.shiftKey });
      }
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (!selection) return;
      if (swallowClick.current) {
        swallowClick.current = false;
        e.preventDefault();
        return;
      }
      const touch = pointerType.current === 'touch' || pointerType.current === 'pen';
      if (e.metaKey || e.ctrlKey || e.shiftKey || (touch && selection.active)) {
        e.preventDefault();
        selection.onPick({ range: e.shiftKey });
      }
    },
  };
}
