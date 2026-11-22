/**
 * How many rows of a note's property list are drawn while the list is limited.
 *
 * A notebook with a dozen fields puts the note's body under the fold: the list is as
 * much the note as the body is, but a record someone opens to read should not open on
 * its filing alone. So the list is limited to a share of the column it sits in, and a
 * toggle in its last row shows the rest.
 *
 * Whole rows, not a height. A box capped at a height cuts the row at its edge in half
 * and has to scroll, and a scrolling region inside a column that already scrolls takes
 * the wheel from the note whenever the pointer happens to rest on it. A list that ends
 * after a row and says how many more there are has neither problem.
 *
 * The cut falls from the end, so the order set in the notebook's field settings is what
 * decides which rows are kept.
 */

/** The share of the note's column the list may take while limited. */
export const CLAMP_SHARE = 0.4;

/**
 * Never fewer rows than this, however short the window: the notebook and the tags are
 * the first two, and a list limited to those alone would hide every field there is.
 */
export const CLAMP_MIN_ROWS = 4;

/**
 * Hiding a row or two is not worth a toggle: it saves little, costs a press every time
 * one of them is wanted, and in a narrow note the toggle can wrap the list's last row to
 * a second line, which takes one row of the saving back. The list is limited only when
 * at least this many go.
 */
export const CLAMP_MIN_HIDDEN = 3;

/**
 * The number of rows to draw, or null when the list is drawn whole.
 *
 * `bottoms` is each row's bottom edge measured from the top of the list, in order, with
 * every row laid out. `budget` is the height the list may take. A budget of nothing is
 * "not measured" (a test's DOM, a column not yet laid out) and limits nothing.
 */
export function rowsThatFit(bottoms: readonly number[], budget: number): number | null {
  if (!(budget > 0)) return null;
  let fit = 0;
  while (fit < bottoms.length && bottoms[fit]! <= budget) fit++;
  const rows = Math.max(fit, CLAMP_MIN_ROWS);
  if (bottoms.length - rows < CLAMP_MIN_HIDDEN) return null;
  return rows;
}
