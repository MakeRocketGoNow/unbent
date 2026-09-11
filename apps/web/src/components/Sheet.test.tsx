import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { Sheet } from './Sheet.js';

/**
 * The modality contract.
 *
 * Everything that makes this a sheet rather than a box — the top layer, the inert
 * background, the scrim, the focus return — is the platform's, and jsdom implements none
 * of it. What is left is the seam: the prop has to be pushed onto the element by calling
 * `showModal`/`close`, and every way the platform can close the element has to come back
 * as `onClose` or the next open finds the element already shut and does nothing.
 *
 * jsdom ships no `showModal`, so these stub it on the prototype and track `open` by hand —
 * the same shape as `Disclosure.test.tsx`'s `matchMedia` stub, and for the same reason.
 */
function stubDialog() {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
  HTMLDialogElement.prototype.showModal = showModal as unknown as () => void;
  HTMLDialogElement.prototype.close = close as unknown as () => void;
  return { showModal, close };
}

const dialogOf = (c: HTMLElement) => c.querySelector('dialog') as HTMLDialogElement;

describe('Sheet', () => {
  afterEach(cleanup);

  /*
     The visible way out.

     The grip at the top looks like a drag handle, and dragging is the one thing this sheet
     deliberately does not implement — so the gesture it advertises does nothing, and without
     a control that does, a phone user's first instinct is a dead end. Asserted here rather
     than left to the callers: every sheet in the app gets this, and a missing ✕ is invisible
     to a type check.
  */
  /*
     The handle.

     jsdom has no pointer capture and no layout, so what is tested is the decision: a pull
     past the threshold closes, a short one does not, a flick closes on speed alone, and an
     upward drag never does. The follow-the-finger translate is checked as the inline style
     it sets, since that is the whole mechanism.
  */
  describe('dragging the grip', () => {
    const grip = (c: HTMLElement) => c.querySelector('.sheet-grip') as HTMLElement;
    /*
       A drag of `ms` milliseconds. The hook reads `performance.now()` at the start and at
       the end, so the clock is stubbed to answer those two reads in order — jsdom fires the
       events microseconds apart, which would make every pull a flick.
    */
    const drag = (el: HTMLElement, from: number, to: number, ms: number) => {
      vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1000 + ms);
      fireEvent.pointerDown(el, { clientY: from, button: 0, pointerId: 1 });
      fireEvent.pointerMove(el, { clientY: to, pointerId: 1 });
      fireEvent.pointerUp(el, { clientY: to, pointerId: 1 });
    };

    beforeEach(() => {
      // jsdom does not implement pointer capture; the hook calls it on every drag.
      HTMLElement.prototype.setPointerCapture = () => {};
    });

    afterEach(() => vi.restoreAllMocks());

    it('follows the finger while it is held', () => {
      stubDialog();
      const { container } = render(
        <Sheet open onClose={() => {}} title="Filter notes">
          body
        </Sheet>,
      );
      const el = grip(container);
      fireEvent.pointerDown(el, { clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(el, { clientY: 140, pointerId: 1 });
      expect(dialogOf(container).style.translate).toBe('0 40px');
      expect(dialogOf(container).hasAttribute('data-dragging')).toBe(true);
    });

    it('closes after a long pull', () => {
      stubDialog();
      const onClose = vi.fn();
      const { container } = render(
        <Sheet open onClose={onClose} title="Filter notes">
          body
        </Sheet>,
      );
      drag(grip(container), 100, 200, 600);
      expect(onClose).toHaveBeenCalledTimes(1);
      // Let go: the inline follow is gone so the stylesheet decides where it rests.
      expect(dialogOf(container).style.translate).toBe('');
      expect(dialogOf(container).hasAttribute('data-dragging')).toBe(false);
    });

    it('snaps back after a short one', () => {
      stubDialog();
      const onClose = vi.fn();
      const { container } = render(
        <Sheet open onClose={onClose} title="Filter notes">
          body
        </Sheet>,
      );
      drag(grip(container), 100, 130, 600);
      expect(onClose).not.toHaveBeenCalled();
      expect(dialogOf(container).style.translate).toBe('');
    });

    it('closes on a quick flick even when it is short', () => {
      stubDialog();
      const onClose = vi.fn();
      const { container } = render(
        <Sheet open onClose={onClose} title="Filter notes">
          body
        </Sheet>,
      );
      drag(grip(container), 100, 140, 40);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    /* The head is part of the handle; the bar alone is too small a target. */
    it('closes after a long pull that starts on the title', () => {
      stubDialog();
      const onClose = vi.fn();
      const { container, getByText } = render(
        <Sheet open onClose={onClose} title="Filter notes">
          body
        </Sheet>,
      );
      drag(getByText('Filter notes'), 100, 200, 600);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    /* A press on the ✕ has to stay a click: capturing it would retarget the pointerup. */
    it('leaves a press on the close button alone', () => {
      stubDialog();
      const onClose = vi.fn();
      const { container, getByLabelText } = render(
        <Sheet open onClose={onClose} title="Filter notes">
          body
        </Sheet>,
      );
      const btn = getByLabelText('Close');
      fireEvent.pointerDown(btn, { clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(btn, { clientY: 200, pointerId: 1 });
      expect(dialogOf(container).style.translate).toBe('');
      expect(dialogOf(container).hasAttribute('data-dragging')).toBe(false);
      fireEvent.pointerUp(btn, { clientY: 200, pointerId: 1 });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('ignores a drag upward', () => {
      stubDialog();
      const onClose = vi.fn();
      const { container } = render(
        <Sheet open onClose={onClose} title="Filter notes">
          body
        </Sheet>,
      );
      const el = grip(container);
      fireEvent.pointerDown(el, { clientY: 200, button: 0, pointerId: 1 });
      fireEvent.pointerMove(el, { clientY: 100, pointerId: 1 });
      expect(dialogOf(container).style.translate).toBe('0 0px');
      fireEvent.pointerUp(el, { clientY: 100, pointerId: 1 });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('offers a close button that dismisses it', () => {
    stubDialog();
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <Sheet open onClose={onClose} title="Filter notes">
        body
      </Sheet>,
    );
    fireEvent.click(getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays shut until it is opened', () => {
    const { showModal } = stubDialog();
    const { container } = render(
      <Sheet open={false} onClose={() => {}} title="Filter notes">
        body
      </Sheet>,
    );
    expect(showModal).not.toHaveBeenCalled();
    expect(dialogOf(container).open).toBe(false);
  });

  /*
   * showModal, never the `open` attribute: setting the attribute opens a non-modal dialog
   * with no backdrop and nothing made inert, which looks like a styling bug rather than
   * the missing modality it actually is.
   */
  it('opens modally, so the rest of the page is inert', () => {
    const { showModal } = stubDialog();
    const { rerender, container } = render(
      <Sheet open={false} onClose={() => {}} title="Filter notes">
        body
      </Sheet>,
    );
    rerender(
      <Sheet open onClose={() => {}} title="Filter notes">
        body
      </Sheet>,
    );
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialogOf(container).open).toBe(true);
  });

  it('closes the element when the prop goes back down', () => {
    const { close } = stubDialog();
    const { rerender } = render(
      <Sheet open onClose={() => {}} title="Filter notes">
        body
      </Sheet>,
    );
    rerender(
      <Sheet open={false} onClose={() => {}} title="Filter notes">
        body
      </Sheet>,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  /*
   * Escape arrives as `cancel`. The state has to follow the element, because a sheet the
   * platform closed while the prop still says open can never be reopened: the effect finds
   * `el.open` already false and does nothing.
   */
  it('reports Escape, so the state cannot fall out of step with the element', () => {
    stubDialog();
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="Filter notes">
        body
      </Sheet>,
    );
    fireEvent(dialogOf(container), new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a close the platform performed on its own, such as the back gesture', () => {
    stubDialog();
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="Filter notes">
        body
      </Sheet>,
    );
    fireEvent(dialogOf(container), new Event('close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked', () => {
    stubDialog();
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="Filter notes">
        body
      </Sheet>,
    );
    fireEvent.click(dialogOf(container));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /*
   * The reason the padding lives on `.sheet-body` and not on the dialog: a click on the
   * dialog's own padding box targets the dialog, and would dismiss the sheet when someone
   * tapped the gap beside a control.
   */
  it('stays open when the click lands on its contents', () => {
    stubDialog();
    const onClose = vi.fn();
    const { container, getByText } = render(
      <Sheet open onClose={onClose} title="Filter notes">
        <button type="button">A control</button>
      </Sheet>,
    );
    fireEvent.click(getByText('A control'));
    fireEvent.click(container.querySelector('.sheet-body') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  /*
   * Pages swap inside one dialog rather than stacking a second sheet, so the arrow is the
   * way back up while Escape and the backdrop still close the whole thing.
   */
  it('offers a way back up only on a sub-page', () => {
    stubDialog();
    const onBack = vi.fn();
    const { queryByLabelText, rerender, getByLabelText } = render(
      <Sheet open onClose={() => {}} title="Filter notes">
        body
      </Sheet>,
    );
    expect(queryByLabelText('Back')).toBeNull();

    rerender(
      <Sheet open onClose={() => {}} title="Tags" onBack={onBack}>
        body
      </Sheet>,
    );
    fireEvent.click(getByLabelText('Back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('takes its accessible name from the page it is showing', () => {
    stubDialog();
    const { container } = render(
      <Sheet open onClose={() => {}} title="Tags" onBack={() => {}}>
        body
      </Sheet>,
    );
    expect(dialogOf(container)).toHaveProperty('ariaLabel', 'Tags');
  });

  /*
   * One component, two edges. The class is the whole difference — everything hard about
   * this (the modality, the four ways out, where the padding lives) is shared, which is why
   * a separate `Drawer` component would have meant maintaining that list twice.
   */
  it('comes from the floor by default and from the side when asked', () => {
    stubDialog();
    const { container, rerender } = render(
      <Sheet open onClose={() => {}} title="Filter notes">
        body
      </Sheet>,
    );
    expect(dialogOf(container).className).toBe('sheet');

    rerender(
      <Sheet open onClose={() => {}} title="Notebooks" side="start">
        body
      </Sheet>,
    );
    expect(dialogOf(container).className).toBe('sheet sheet-side');
  });

  it('closes the same four ways whichever edge it came from', () => {
    stubDialog();
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open onClose={onClose} title="Notebooks" side="start">
        body
      </Sheet>,
    );
    fireEvent(dialogOf(container), new Event('cancel', { cancelable: true }));
    fireEvent.click(dialogOf(container));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('names itself for a screen reader and on screen, and carries a head action', () => {
    stubDialog();
    const { container, getByText } = render(
      <Sheet open onClose={() => {}} title="Filter notes" headAction={<button>Clear all</button>}>
        body
      </Sheet>,
    );
    expect(dialogOf(container)).toHaveProperty('ariaLabel', 'Filter notes');
    expect(getByText('Filter notes').tagName).toBe('H2');
    expect(getByText('Clear all')).toBeTruthy();
  });
});
