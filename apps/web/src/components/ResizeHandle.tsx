import { useRef, useState } from 'react';

interface ResizeHandleProps {
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  /** The element the pointer is measured against — the grid this handle sits in. */
  containerRef: React.RefObject<HTMLElement>;
  /**
   * Maps a pointer position to a value. Only the caller knows whether a pixel is a
   * sidebar width or a fraction of the pane row, so the handle stays unit-agnostic.
   *
   * `gap` is the distance between the container's left edge and the handle's own left
   * edge, minus the track the caller is sizing — in other words the channel the grid puts
   * before the handle. A caller sizing a column in pixels has to subtract it, or the
   * value it computes places the divider a channel further right than the pointer.
   */
  toValue: (clientX: number, rect: DOMRect, gap: number) => number;
  /** Fires on every pointermove — cheap, state only. */
  onResize: (next: number) => void;
  /** Fires on pointer release, arrow keys, and reset — this one is persisted. */
  onCommit: (next: number) => void;
  /** Current value, and the limits announced to assistive tech. */
  value: number;
  min: number;
  max: number;
  /** Arrow-key increment, in the caller's unit. */
  step: number;
  /** Double-click and Home return here. */
  defaultValue: number;
  /** Announced instead of the bare number when a percentage reads better than a count. */
  valueText?: string;
  /** ARIA wants an integer; the split stores a 0–1 fraction, which would round to 0 or 1. */
  toAriaValue?: (value: number) => number;
}

/**
 * The drag handle between two grid tracks.
 *
 * It is a zero-width grid item rather than an absolutely positioned overlay, so it cannot
 * drift out of alignment with the columns it divides; the hit area comes from a `::before`
 * spread across the surrounding gap. The visible line stays the neighbouring border, which
 * the handle only tints when hovered, focused, or dragged — the affordance appears when
 * reached for rather than adding a permanent seam to the layout.
 *
 * `role="separator"` with `aria-valuenow` is what screen readers announce as adjustable;
 * a button would imply activation. `aria-orientation` describes the separator's own axis —
 * a vertical line — not the direction it travels, which is the commonly inverted one.
 */
export function ResizeHandle({
  label,
  containerRef,
  toValue,
  onResize,
  onCommit,
  value,
  min,
  max,
  step,
  defaultValue,
  valueText,
  toAriaValue,
}: ResizeHandleProps) {
  /**
   * Whether a drag is in progress, in a ref rather than state.
   *
   * State would be a bug here: the handlers close over the render that attached them, so
   * a pointermove arriving in the same tick as `setDragging(true)` still reads `false`
   * and returns early — the drag silently does nothing and the selection lock is never
   * released. A ref is written synchronously and is correct on the very next event.
   */
  const dragging = useRef(false);
  /** Mirrors the ref for the hover/drag tint, which is the one thing that needs a render. */
  const [active, setActive] = useState(false);
  /** The last value seen during a drag, committed once on release. */
  const latest = useRef(value);

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    containerRef.current?.removeAttribute('data-resizing');
    onCommit(latest.current);
  }

  /** The handle's own element, for measuring where the grid actually placed it. */
  const self = useRef<HTMLDivElement>(null);

  /**
   * The channel the grid puts between the sized track and this handle.
   *
   * Measured rather than passed in as a constant: the gap is a CSS value that the layout
   * owns, and a number duplicated in the component would drift the moment the stylesheet
   * changed. Reading it from the rendered geometry keeps the two in step.
   */
  function channelBefore(): number {
    const container = containerRef.current;
    const handle = self.current;
    if (!container || !handle) return 0;

    const previous = handle.previousElementSibling;
    if (!previous) return 0;
    return handle.getBoundingClientRect().left - previous.getBoundingClientRect().right;
  }

  function measure(clientX: number): number | null {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return toValue(clientX, rect, channelBefore());
  }

  return (
    <div
      ref={self}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={toAriaValue ? toAriaValue(value) : Math.round(value)}
      aria-valuemin={toAriaValue ? toAriaValue(min) : Math.round(min)}
      aria-valuemax={toAriaValue ? toAriaValue(max) : Math.round(max)}
      aria-valuetext={valueText}
      tabIndex={0}
      className="resize-handle"
      data-dragging={active || undefined}
      onPointerDown={(e) => {
        // Stops the drag from selecting text in the panes it passes over.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        latest.current = value;
        dragging.current = true;
        setActive(true);
        // Suppresses text selection across the whole grid, not just this handle — the
        // pointer travels over the note list and the editor while dragging.
        containerRef.current?.setAttribute('data-resizing', '');
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const next = measure(e.clientX);
        if (next === null) return;
        latest.current = next;
        onResize(next);
      }}
      onPointerUp={endDrag}
      // A cancelled drag (a system gesture, or the pointer leaving the window) still has
      // to release the selection lock, or the app is left unselectable until reload.
      onPointerCancel={endDrag}
      // Matches Home, and is the gesture people try first on a divider.
      onDoubleClick={() => onCommit(defaultValue)}
      onKeyDown={(e) => {
        // Shift for a coarse step, matching how sliders behave elsewhere.
        const distance = e.shiftKey ? step * 10 : step;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onCommit(value - distance);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          onCommit(value + distance);
        } else if (e.key === 'Home') {
          e.preventDefault();
          onCommit(defaultValue);
        }
      }}
    />
  );
}
