import { useEffect, useRef, type ReactNode } from 'react';
import { BackArrow } from './BackArrow.js';

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
 * Deliberately not draggable. Drag-to-dismiss is the one part of the native sheet the
 * platform does not provide, and hand-rolling a gesture that fights the sheet's own scroll
 * is how these end up feeling broken. The backdrop, Escape, the back gesture and Done are
 * four ways out already.
 *
 * One component for both edges rather than a `Drawer` beside a `Sheet`: everything that is
 * hard here — the modality, the four ways out, the padding that must not be on the dialog —
 * is the same for both, and the difference is which edge the box is pinned to. Splitting
 * them would mean maintaining that list twice.
 */
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
        {/* Decorative: it says "this is a sheet" in the vocabulary phones have taught, and
            it is not a control, because there is no drag to hint at. */}
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          {onBack && (
            <button type="button" className="icon-btn sheet-back" aria-label="Back" onClick={onBack}>
              <BackArrow />
            </button>
          )}
          <h2>{title}</h2>
          {headAction}
        </div>
        {children}
      </div>
    </dialog>
  );
}
