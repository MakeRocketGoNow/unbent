import { useEffect, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { usePersistentState, clamp } from './usePersistentState.js';

/** The pre-resize default, in px: 19rem at the root font size. Changing this changes what
 *  "reset" means for anyone who has already dragged the handle. */
export const SIDEBAR_DEFAULT = 304;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;

/**
 * The same three for the list drawn as a table beside an open note.
 *
 * A separate range, and a separate stored width, because a width dragged for six columns
 * is never the width anyone wants the list at: sharing one key would turn every toggle
 * between the two into a resize. The ceiling is wide because a table earns its width; the
 * stylesheet still caps it so the note beside it never drops below a phone's width.
 */
export const TABLE_DEFAULT = 640;
export const TABLE_MIN = 320;
export const TABLE_MAX = 1100;

/** How the list is drawn: the sidebar of entries, or the table of a notebook's fields. */
export type NotesViewMode = 'list' | 'table';

const within = (min: number, max: number) => (raw: unknown) =>
  typeof raw === 'number' && raw >= min && raw <= max ? raw : undefined;

/**
 * The shared state behind the `.notes` grid, for both the notes and trash shells.
 *
 * The two layouts duplicate their sidebar markup because their sidebars genuinely have
 * nothing in common: one has search and filters, the other has restore and delete. What
 * they do share is this grid, and the mobile rule has to agree between them or backing out
 * of a trashed note lands on a blank screen.
 *
 * The width is returned as a custom property rather than a `gridTemplateColumns`
 * declaration, and that is load-bearing rather than stylistic: an inline layout property
 * outranks every stylesheet rule including media queries, so a width dragged on a desktop
 * would pin a phone to two columns permanently. A custom property is inert until some rule
 * consumes it, and the mobile rules deliberately never mention this one.
 *
 * In table mode the grid carries `table-view`, and the width the handle drags is the
 * table's. Both custom properties are always set, whichever mode is on: the desktop
 * filter panel sizes itself from `--sidebar-width` and must keep doing so over a table.
 */
export function useNotesLayout(
  noteRoute: '/notes/$noteId' | '/trash/$noteId',
  { mode = 'list' }: { mode?: NotesViewMode } = {},
) {
  /** Undefined unless a note is open. Below the mobile breakpoint this is what decides
   *  whether the list or the note is on screen; above it, nothing reads it. */
  const open = useParams({ from: noteRoute, shouldThrow: false })?.noteId;

  const [storedSidebar, setStoredSidebar] = usePersistentState(
    'sidebarWidth',
    SIDEBAR_DEFAULT,
    within(SIDEBAR_MIN, SIDEBAR_MAX),
  );
  const [storedTable, setStoredTable] = usePersistentState(
    'tableWidth',
    TABLE_DEFAULT,
    within(TABLE_MIN, TABLE_MAX),
  );

  /**
   * The width being dragged right now.
   *
   * Separate from the stored one so a drag re-renders without writing: committing every
   * pointermove would be roughly sixty synchronous localStorage writes a second, and
   * `setItem` hits disk.
   */
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebar);
  const [tableWidth, setTableWidth] = useState(storedTable);
  // Another tab (or a reset elsewhere) changing the stored width should win over a stale
  // local one. No-ops during a drag, because the drag is what set the stored one in the
  // first place.
  useEffect(() => setSidebarWidth(storedSidebar), [storedSidebar]);
  useEffect(() => setTableWidth(storedTable), [storedTable]);

  const containerRef = useRef<HTMLDivElement>(null);

  const table = mode === 'table';
  const min = table ? TABLE_MIN : SIDEBAR_MIN;
  const max = table ? TABLE_MAX : SIDEBAR_MAX;
  const classes = ['notes'];
  if (open) classes.push('note-open');
  if (table) classes.push('table-view');

  return {
    open,
    containerRef,
    className: classes.join(' '),
    style: {
      '--sidebar-width': `${sidebarWidth}px`,
      '--table-width': `${tableWidth}px`,
    } as React.CSSProperties,
    /** The width the handle is dragging in this mode, and its range. */
    width: table ? tableWidth : sidebarWidth,
    min,
    max,
    defaultValue: table ? TABLE_DEFAULT : SIDEBAR_DEFAULT,
    /** Every pointermove: state only, no storage. */
    onResize: (next: number) =>
      (table ? setTableWidth : setSidebarWidth)(clamp(next, min, max)),
    /** Pointer release, keypress, or reset: the value that should outlive the session. */
    onResizeCommit: (next: number) =>
      (table ? setStoredTable : setStoredSidebar)(clamp(next, min, max)),
  };
}
