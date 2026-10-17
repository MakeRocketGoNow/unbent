/**
 * The grid picker for choosing a table's size.
 *
 * Lives on its own, knowing nothing about CodeMirror or React, because two callers need
 * exactly the same control: the toolbar over a table the cursor is in, and the formatting
 * bar's table button. They differ only in what a click does and whether there is a current
 * size to seed from: everything else, including the markup and the class names it is
 * styled by, has to stay identical or the same icon starts meaning two different things.
 */

/** Largest grid on offer, sized to fit without scrolling. */
export const PICKER_ROWS = 8;
export const PICKER_COLUMNS = 6;

export interface PickerOptions {
  /**
   * The table's current size, when opening on one that already exists.
   *
   * Seeding matters: an empty grid says nothing about what a click will do to a table that
   * is already there, while a seeded one is a size being dragged away from, so shrinking
   * reads as deliberate rather than as a surprise.
   */
  current?: { rows: number; columns: number } | null;
  /** Applied when a cell is clicked. */
  onPick: (rows: number, columns: number) => void;
}

/** Builds the picker element. The caller owns placing and removing it. */
export function buildSizePicker({ current = null, onPick }: PickerOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cm-table-picker';

  const grid = document.createElement('div');
  grid.className = 'cm-table-picker-grid';
  const label = document.createElement('div');
  label.className = 'cm-table-picker-label';

  const cells: HTMLElement[] = [];
  for (let r = 1; r <= PICKER_ROWS; r += 1) {
    for (let c = 1; c <= PICKER_COLUMNS; c += 1) {
      const cell = document.createElement('span');
      cell.className = 'cm-table-picker-cell';
      cell.dataset['row'] = String(r);
      cell.dataset['column'] = String(c);
      grid.appendChild(cell);
      cells.push(cell);
    }
  }

  /**
   * Paints the grid for a candidate size.
   *
   * Cells the click would discard are marked separately, so shrinking a table looks
   * different from growing one and is never done without being shown first.
   */
  function highlight(rows: number, columns: number) {
    for (const cell of cells) {
      const r = Number(cell.dataset['row']);
      const c = Number(cell.dataset['column']);
      const selected = r <= rows && c <= columns;
      const wasInTable = current !== null && r <= current.rows && c <= current.columns;

      cell.classList.toggle('on', selected);
      cell.classList.toggle('losing', !selected && wasInTable);
    }

    if (rows === 0) {
      label.textContent = current ? `${current.rows} × ${current.columns}` : 'Insert table';
      return;
    }

    const shrinking = current !== null && (rows < current.rows || columns < current.columns);
    label.textContent = `${rows} × ${columns}${shrinking ? ' (trims)' : ''}`;
  }

  grid.addEventListener('mouseover', (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-table-picker-cell');
    if (cell) highlight(Number(cell.dataset['row']), Number(cell.dataset['column']));
  });
  // Back to the table's real size on the way out, never to an empty grid.
  grid.addEventListener('mouseleave', () => {
    if (current) highlight(current.rows, current.columns);
    else highlight(0, 0);
  });

  grid.addEventListener('mousedown', (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-table-picker-cell');
    if (!cell) return;
    // Without this the editor blurs first and loses the selection the caller acts on.
    event.preventDefault();
    onPick(Number(cell.dataset['row']), Number(cell.dataset['column']));
  });

  if (current) highlight(current.rows, current.columns);
  else highlight(0, 0);

  wrap.appendChild(grid);
  wrap.appendChild(label);
  return wrap;
}

/**
 * The picker's styles, as a plain CSS string.
 *
 * Duplicated out of the CodeMirror theme so the React toolbar's copy looks identical: a
 * theme's rules are scoped to the editor and do not reach a popover mounted beside it.
 */
export const PICKER_CSS = `
.cm-table-picker {
  padding: 0.4rem;
  background: var(--bg, #fff);
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 0.35rem;
  box-shadow: 0 2px 8px color-mix(in srgb, currentColor 15%, transparent);
  z-index: 20;
}
.cm-table-picker-grid {
  display: grid;
  grid-template-columns: repeat(${PICKER_COLUMNS}, 1rem);
  gap: 2px;
}
.cm-table-picker-cell {
  width: 1rem;
  height: 1rem;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 2px;
}
.cm-table-picker-cell.on {
  background: var(--accent, #9c3f6d);
  border-color: var(--accent, #9c3f6d);
}
.cm-table-picker-cell.losing {
  border-color: #c0392b;
  border-style: dashed;
}
.cm-table-picker-label {
  padding-top: 0.35rem;
  text-align: center;
  font-size: 0.75rem;
  opacity: 0.6;
}
`;
