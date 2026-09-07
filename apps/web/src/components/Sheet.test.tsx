import { describe, it, expect, afterEach, vi } from 'vitest';
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
