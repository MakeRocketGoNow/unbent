import { useEffect, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { usePersistentState, clamp } from './usePersistentState.js';

/** The pre-resize default, in px: 19rem at the root font size. Changing this changes what
 *  "reset" means for anyone who has already dragged the handle. */
export const SIDEBAR_DEFAULT = 304;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;

/**
 * The shared state behind the `.notes` grid, for both the notes and trash shells.
 *
 * The two layouts duplicate their sidebar markup because their sidebars genuinely have
 * nothing in common — one has search and filters, the other has restore and delete. What
 * they do share is this grid, and the mobile rule has to agree between them or backing out
 * of a trashed note lands on a blank screen.
 *
 * The width is returned as a custom property rather than a `gridTemplateColumns`
 * declaration, and that is load-bearing rather than stylistic: an inline layout property
 * outranks every stylesheet rule including media queries, so a width dragged on a desktop
 * would pin a phone to two columns permanently. A custom property is inert until some rule
 * consumes it, and the mobile rules deliberately never mention this one.
 */
export function useNotesLayout(noteRoute: '/notes/$noteId' | '/trash/$noteId') {
  /** Undefined unless a note is open. Below the mobile breakpoint this is what decides
   *  whether the list or the note is on screen; above it, nothing reads it. */
  const open = useParams({ from: noteRoute, shouldThrow: false })?.noteId;

  const [stored, setStored] = usePersistentState('sidebarWidth', SIDEBAR_DEFAULT, (raw) =>
    typeof raw === 'number' && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX ? raw : undefined,
  );

  /**
   * The width being dragged right now.
   *
   * Separate from the stored one so a drag re-renders without writing: committing every
   * pointermove would be roughly sixty synchronous localStorage writes a second, and
   * `setItem` hits disk.
   */
  const [width, setWidth] = useState(stored);
  // Another tab (or a reset elsewhere) changing the stored width should win over a stale
  // local one. No-ops during a drag, because the drag is what set `stored` in the first place.
  useEffect(() => setWidth(stored), [stored]);

  const containerRef = useRef<HTMLDivElement>(null);

  return {
    open,
    containerRef,
    className: open ? 'notes note-open' : 'notes',
    style: { '--sidebar-width': `${width}px` } as React.CSSProperties,
    width,
    /** Every pointermove: state only, no storage. */
    onResize: (next: number) => setWidth(clamp(next, SIDEBAR_MIN, SIDEBAR_MAX)),
    /** Pointer release, keypress, or reset: the value that should outlive the session. */
    onResizeCommit: (next: number) => setStored(clamp(next, SIDEBAR_MIN, SIDEBAR_MAX)),
  };
}
