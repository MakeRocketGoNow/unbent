import { describe, expect, it, vi } from 'vitest';
import { buildSizePicker, PICKER_COLUMNS, PICKER_ROWS } from './table-size-picker.js';

/** The cell at a 1-based row and column, as the grid lays them out. */
function cellAt(picker: HTMLElement, row: number, column: number): HTMLElement {
  const found = picker.querySelector<HTMLElement>(
    `.cm-table-picker-cell[data-row="${row}"][data-column="${column}"]`,
  );
  if (!found) throw new Error(`no cell at ${row},${column}`);
  return found;
}

function label(picker: HTMLElement): string {
  return picker.querySelector('.cm-table-picker-label')?.textContent ?? '';
}

function hover(cell: HTMLElement) {
  cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

describe('buildSizePicker', () => {
  it('renders the full grid', () => {
    const picker = buildSizePicker({ onPick: () => {} });
    expect(picker.querySelectorAll('.cm-table-picker-cell')).toHaveLength(
      PICKER_ROWS * PICKER_COLUMNS,
    );
  });

  /** With no table to seed from, nothing is preselected and the label says what it does. */
  it('opens empty when there is no current size', () => {
    const picker = buildSizePicker({ onPick: () => {} });
    expect(picker.querySelectorAll('.cm-table-picker-cell.on')).toHaveLength(0);
    expect(label(picker)).toBe('Insert table');
  });

  /**
   * Seeding is what makes the picker a resize control: an empty grid says nothing about
   * what a click will do to a table that already exists.
   */
  it('opens showing the current size', () => {
    const picker = buildSizePicker({ current: { rows: 3, columns: 2 }, onPick: () => {} });
    expect(picker.querySelectorAll('.cm-table-picker-cell.on')).toHaveLength(6);
    expect(label(picker)).toBe('3 × 2');
  });

  it('highlights the hovered size', () => {
    const picker = buildSizePicker({ onPick: () => {} });
    hover(cellAt(picker, 2, 3));
    expect(picker.querySelectorAll('.cm-table-picker-cell.on')).toHaveLength(6);
    expect(label(picker)).toBe('2 × 3');
  });

  /** Shrinking drops cells, so what would be lost is shown before it is chosen. */
  it('marks the cells a smaller choice would discard', () => {
    const picker = buildSizePicker({ current: { rows: 3, columns: 3 }, onPick: () => {} });
    hover(cellAt(picker, 1, 1));
    expect(picker.querySelectorAll('.cm-table-picker-cell.losing')).toHaveLength(8);
    expect(label(picker)).toContain('trims');
  });

  it('does not warn when growing', () => {
    const picker = buildSizePicker({ current: { rows: 2, columns: 2 }, onPick: () => {} });
    hover(cellAt(picker, 4, 4));
    expect(picker.querySelectorAll('.cm-table-picker-cell.losing')).toHaveLength(0);
    expect(label(picker)).toBe('4 × 4');
  });

  it('reports the chosen size', () => {
    const onPick = vi.fn();
    const picker = buildSizePicker({ onPick });
    cellAt(picker, 3, 5).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onPick).toHaveBeenCalledWith(3, 5);
  });

  /** A click that blurred the editor first would drop the selection the caller acts on. */
  it('prevents the default mousedown so focus is not lost', () => {
    const picker = buildSizePicker({ onPick: () => {} });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    cellAt(picker, 1, 1).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  /** Leaving the grid returns to the table's real size, never to an empty one. */
  it('restores the current size on mouseleave', () => {
    const picker = buildSizePicker({ current: { rows: 2, columns: 2 }, onPick: () => {} });
    hover(cellAt(picker, 5, 5));
    picker
      .querySelector('.cm-table-picker-grid')!
      .dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    expect(label(picker)).toBe('2 × 2');
  });
});
