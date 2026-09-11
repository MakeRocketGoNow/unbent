import { useEffect, useRef, type ReactNode } from 'react';
import { BackArrow } from './BackArrow.js';
import { CloseIcon } from './icons.js';

export interface SheetProps {
  open: boolean;
  /** Called for every way out: Done, the backdrop, Escape, and the platform's own back. */
  onClose: () => void;
  /** Names the sheet for a screen reader, and heads it on screen. */
  title: string;
  /** Shown at the right of the title row, when there is something to clear. */
  headAction?: ReactNode;
  /**
   * Go back to the sheet's previous page, drawn as an arrow before the title.
   *
   * Set only on a sub-page. A sheet that shows another sheet dims the first one behind the
   * second and leaves two scrims on the screen, so pages swap inside one dialog instead —
   * Android's `FilterSheet` makes the same choice and records the same reason. This arrow
   * is the way back up; Escape and the backdrop still close the whole thing, because that
   * is what a scrim means.
   */
  onBack?: () => void;
  /**
   * Which edge it comes from.
   *
   * `bottom` is a sheet about the whole view — the filters, which are about the list behind
   * them. `start` is navigation: a drawer of places to go, which is why it takes the side
   * the back gesture and the hamburger both live on, and why it runs the full height rather
   * than sizing to its content.
   */
  side?: 'bottom' | 'start';
  children: ReactNode;
}

/**
 * A sheet, on the platform's `<dialog>` — from the floor by default, or from the side.
 *
 * Nothing else in this app portals, and both `OverflowMenu` and `Confirm` carry comments
 * explaining why they do not — a menu of three items and an inline confirmation about a
 * named thing on screen need none of the machinery, and a confirmation especially must not
 * cover the very thing being decided about. This is the case those comments leave room for
 * rather than a contradiction of them: a surface holding six controls, which on a phone is
 * most of the screen, and which is *about* the list behind it rather than about one row of
 * it.
 *
 * `showModal()` is what makes that affordable. The browser puts the element in the top
 * layer, so there is no portal; makes the rest of the document inert, so there is no focus
 * trap to write; closes on Escape and on the platform's back gesture, so there is no key
 * handling; draws the scrim through `::backdrop`; and returns focus to whatever opened it.
 * Every part of the pattern this codebase declined to hand-roll is a part the platform is
 * doing. It is the same trade `Disclosure` makes with `<details>`.
 *
 * Draggable by its grip, and only by its grip.
 *
 * Drag-to-dismiss is the one part of the native sheet the platform does not provide. The
 * usual hand-rolled version listens on the whole sheet, and that is the one that feels
 * broken: a drag that begins on a scrolled list has to decide, mid-gesture, whether it is
 * scrolling or dismissing, and getting that wrong strands the sheet half off the screen.
 * A drag that begins on the grip or the title has no such question to answer — neither is
 * scrollable content, so a finger there can only mean one thing. That is the gesture
 * `useGripDrag` implements, on the grip and on the head around it, and the reason it does
 * not reach any further down. The head is included for the same reason a native sheet's
 * whole header drags: the bar is 4px and a thumb lands near it, not on it.
 *
 * The ✕ stays on the bottom sheet. Not everyone finds the grip, a mouse on a desktop has
 * no swipe, and a control that says "close" costs nothing beside a handle that only
 * implies it.
 *
 * The drawer has none. Its head is the wordmark and the account, which is what Keep's
 * drawer is headed by, and a ✕ beside them made a navigation panel read as a dialog about
 * something. The ways out it keeps are the ones a drawer is expected to have — the scrim,
 * Escape, the platform's back gesture — and picking a row, which is how a drawer is
 * normally left. A screen reader still has Escape, which the platform wires for a modal
 * dialog without any help from here.
 *
 * One component for both edges rather than a `Drawer` beside a `Sheet`: everything that is
 * hard here — the modality, the four ways out, the padding that must not be on the dialog —
 * is the same for both, and the difference is which edge the box is pinned to. Splitting
 * them would mean maintaining that list twice.
 */
/** How far, in px, a grip drag has to travel before letting go closes the sheet. */
const DISMISS_DISTANCE = 72;
/** Or how fast, in px/ms: a short flick should close it as surely as a long pull. */
const DISMISS_VELOCITY = 0.6;

/**
 * The grip's drag.
 *
 * Pointer events rather than touch events, so a mouse can do it too and so there is one
 * code path. `setPointerCapture` keeps the move and up events coming to the grip after the
 * finger has left its 4px box, which it does within the first few pixels of any drag.
 *
 * A press that lands on a control inside the head — the ✕, a Back arrow, a head action —
 * is left alone entirely: it has to reach that control as a click, and capturing it here
 * would retarget the pointerup and swallow the click.
 *
 * The sheet follows the finger downward by setting `translate` inline — that overrides the
 * stylesheet's open-state `translate: 0 0` for the duration — and `data-dragging` switches
 * the rise transition off so the follow is immediate rather than eased 220ms behind. On
 * release the inline value is cleared: either the sheet snaps back under its transition,
 * or `onClose` runs and it leaves the way it always does. Upward drags are ignored; the
 * sheet does not stretch.
 */
function useGripDrag(sheet: React.RefObject<HTMLDialogElement | null>, onClose: () => void) {
  const start = useRef<{ y: number; t: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('button, a, input, select, textarea')) return;
    // Timed here rather than from the event: a synthetic event's stamp is whatever the
    // browser (or a test) gave the native one, and the velocity has to be measured on the
    // same clock at both ends.
    start.current = { y: e.clientY, t: performance.now() };
    e.currentTarget.setPointerCapture(e.pointerId);
    sheet.current?.setAttribute('data-dragging', '');
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || !sheet.current) return;
    const dy = Math.max(0, e.clientY - start.current.y);
    sheet.current.style.translate = `0 ${dy}px`;
  };

  const end = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const s = start.current;
    start.current = null;
    const el = sheet.current;
    if (!el) return;
    el.removeAttribute('data-dragging');
    el.style.translate = '';
    if (cancelled || !s) return;
    const dy = e.clientY - s.y;
    const dt = Math.max(1, performance.now() - s.t);
    if (dy >= DISMISS_DISTANCE || (dy > 0 && dy / dt >= DISMISS_VELOCITY)) onClose();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => end(e, false),
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => end(e, true),
  };
}

export function Sheet({
  open,
  onClose,
  title,
  headAction,
  onBack,
  side = 'bottom',
  children,
}: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const grip = useGripDrag(ref, onClose);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    /*
     * `open` is a prop here but a DOM state on the element, and the two are only kept in
     * step by calling these methods — setting the attribute directly opens a non-modal
     * dialog with no backdrop and no inertness, which looks like a styling bug rather than
     * the missing modality it is.
     */
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={side === 'start' ? 'sheet sheet-side' : 'sheet'}
      aria-label={title}
      // Escape. The event is the platform telling us it is about to close; the state has to
      // follow or the next `open` finds `el.open` already false and does nothing.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The back gesture and anything else that closes the element without asking us first.
      onClose={onClose}
      /*
       * The backdrop.
       *
       * A click on it targets the dialog itself, because the backdrop is a pseudo-element
       * with no node of its own — so the test is whether the target *is* the dialog rather
       * than something inside it. That only holds because the padding belongs to the inner
       * wrapper below: give the dialog padding and its own padding box becomes a strip that
       * dismisses the sheet when tapped, which reads as the sheet closing at random.
       */
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="sheet-body">
        {/*
            The handle. The drawn bar is 4px; the element is taller than that (see
            `.sheet-grip`) so a thumb can find it. Hidden from assistive tech on purpose —
            the gesture has no keyboard equivalent and needs none, because the ✕ beside it
            is the accessible way out.
        */}
        <div className="sheet-grip" aria-hidden="true" {...grip} />
        {/* The head is part of the handle: see the note on `useGripDrag`. */}
        <div className="sheet-head" {...grip}>
          {onBack && (
            <button type="button" className="icon-btn sheet-back" aria-label="Back" onClick={onBack}>
              <BackArrow />
            </button>
          )}
          <h2>{title}</h2>
          {headAction}
          {/* Last in the row, where a phone has taught people to look for it. Not on the
              drawer — see the note on the ✕ above. */}
          {side === 'bottom' && (
            <button
              type="button"
              className="icon-btn sheet-close"
              aria-label="Close"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          )}
        </div>
        {children}
      </div>
    </dialog>
  );
}
