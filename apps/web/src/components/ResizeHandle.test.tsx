import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from './ResizeHandle.js';

/**
 * The handle passes `toValue` the channel the grid puts before it, measured from the
 * rendered geometry. jsdom reports every box as zero, so the elements are given explicit
 * rects — the arithmetic under test is exactly what those rects feed.
 */
function stubRect(el: Element, box: { left: number; right: number }) {
  el.getBoundingClientRect = () =>
    ({ left: box.left, right: box.right, width: box.right - box.left, top: 0, bottom: 0, height: 0, x: box.left, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function setup(toValue: (clientX: number, rect: DOMRect, gap: number) => number) {
  const containerRef = createRef<HTMLElement>();
  const onResize = vi.fn();

  render(
    <div ref={containerRef as never} data-testid="container">
      <div data-testid="previous" />
      <ResizeHandle
        label="Resize sidebar"
        containerRef={containerRef as never}
        toValue={toValue}
        value={304}
        min={180}
        max={520}
        step={16}
        defaultValue={304}
        onResize={onResize}
        onCommit={vi.fn()}
      />
    </div>,
  );

  const handle = screen.getByRole('separator');
  // Grid at x=24, sidebar ending at 328, a 16px channel, handle at 344.
  stubRect(screen.getByTestId('container'), { left: 24, right: 1224 });
  stubRect(screen.getByTestId('previous'), { left: 24, right: 328 });
  stubRect(handle, { left: 344, right: 345 });

  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => false);

  return { handle, onResize };
}

/** A pointer event jsdom will construct; PointerEvent itself is not implemented there. */
function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

afterEach(cleanup);

describe('ResizeHandle', () => {
  /**
   * The divider does not render at the sized track's edge — the grid puts a channel
   * before it. Without subtracting that channel the computed width placed the handle a
   * channel further right than the pointer, and it trailed the cursor for the whole drag.
   */
  it('passes the channel between the previous track and itself', () => {
    const toValue = vi.fn((clientX: number, rect: DOMRect, gap: number) => clientX - rect.left - gap);
    const { handle, onResize } = setup(toValue);

    handle.dispatchEvent(pointer('pointerdown', 344));
    handle.dispatchEvent(pointer('pointermove', 400));

    expect(toValue).toHaveBeenCalledWith(400, expect.anything(), 16);
    // 400 - 24 (grid left) - 16 (channel) = 360.
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  /**
   * With the pointer on the divider, the width it computes has to be the width the
   * divider already sits at — otherwise the handle jumps on the first move.
   */
  it('computes the current width when the pointer is on the divider', () => {
    const { handle, onResize } = setup((clientX, rect, gap) => clientX - rect.left - gap);

    handle.dispatchEvent(pointer('pointerdown', 344));
    handle.dispatchEvent(pointer('pointermove', 344));

    // 344 - 24 - 16 = 304, which is the sidebar's actual width.
    expect(onResize).toHaveBeenLastCalledWith(304);
  });

  it('reports no channel when it has no preceding sibling', () => {
    const containerRef = createRef<HTMLElement>();
    const toValue = vi.fn((clientX: number, rect: DOMRect, gap: number) => gap);

    render(
      <div ref={containerRef as never}>
        <ResizeHandle
          label="Resize" containerRef={containerRef as never} toValue={toValue}
          value={0} min={0} max={10} step={1} defaultValue={0}
          onResize={vi.fn()} onCommit={vi.fn()}
        />
      </div>,
    );

    const handle = screen.getByRole('separator');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => false);
    handle.dispatchEvent(pointer('pointerdown', 10));
    handle.dispatchEvent(pointer('pointermove', 10));

    expect(toValue).toHaveBeenCalledWith(10, expect.anything(), 0);
  });
});
