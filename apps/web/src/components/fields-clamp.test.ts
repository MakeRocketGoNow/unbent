import { describe, it, expect } from 'vitest';
import { rowsThatFit } from './fields-clamp.js';

/** Rows of one height, the way a list of plain values lays out. */
const even = (count: number, height = 30) => Array.from({ length: count }, (_, i) => (i + 1) * height);

describe('rowsThatFit', () => {
  it('draws the list whole when it fits', () => {
    expect(rowsThatFit(even(10), 300)).toBeNull();
  });

  it('cuts after the last row that ends inside the budget', () => {
    // Ten rows of 30 end at 300; the eleventh would end at 330.
    expect(rowsThatFit(even(14), 310)).toBe(10);
    expect(rowsThatFit(even(14), 300)).toBe(10);
  });

  it('counts a tall row by where it ends, not by how many came before', () => {
    // The second row (the tags, say) wrapped to three lines.
    expect(rowsThatFit([30, 120, 150, 180, 210, 240, 270, 300, 330], 200)).toBe(4);
  });

  it('keeps four rows in a window too short for them', () => {
    expect(rowsThatFit(even(12), 40)).toBe(4);
  });

  it('does not hide a row or two', () => {
    expect(rowsThatFit(even(11), 300)).toBeNull();
    expect(rowsThatFit(even(12), 300)).toBeNull();
    expect(rowsThatFit(even(13), 300)).toBe(10);
  });

  it('never cuts above the row that holds focus', () => {
    // Seven rows fit; the keyboard opens and only four do, with the sixth being typed in.
    expect(rowsThatFit(even(14), 130)).toBe(4);
    expect(rowsThatFit(even(14), 130, 6)).toBe(6);
    // A floor under the cut changes nothing, and one near the end leaves the list whole.
    expect(rowsThatFit(even(14), 310, 6)).toBe(10);
    expect(rowsThatFit(even(14), 130, 12)).toBeNull();
  });

  it('limits nothing when the column has not been measured', () => {
    expect(rowsThatFit(even(30), 0)).toBeNull();
    expect(rowsThatFit(even(30), Number.NaN)).toBeNull();
  });
});
