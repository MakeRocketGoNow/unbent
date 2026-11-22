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

/**
 * The share of the note's column the list may take while limited.
 *
 * It was 0.4, the middle of "a third to a half", and on a desktop that was still nine
 * rows of filing above the body: a lot, for a list whose rest is one press away. 0.3
 * took one row off that, which nobody would notice. At a quarter a desktop window draws
 * about six rows and a phone the floor of four (`CLAMP_MIN_ROWS`), which is the notebook,
 * the tags and the first few fields: enough to say what the note is, with most of the
 * screen left for what it says.
 */
export const CLAMP_SHARE = 0.25;

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
 * How long the room must have stopped changing before the cut moves up for it.
 *
 * A change of size that leaves room for more rows shows them at once; one that leaves
 * room for fewer waits this long and is read again. The Android app's keyboard closes
 * over a quarter of a second, and the column grows back as it goes: read at once, the
 * moment focus left a field the list was cut for the keyboard's height, then given its
 * rows back a beat later as the keyboard finished leaving. A window being dragged
 * shorter did a slower version of the same thing, a row at a time under the pointer.
 *
 * Twice the keyboard's quarter second. At 300ms a slow emulator's WebView still showed
 * the cut and its undoing once in two tries, the height coming back just after the wait
 * ran out; the cost of the margin is a list that takes half a second to shorten after a
 * resize, which nobody is waiting on.
 */
export const CLAMP_SETTLE_MS = 500;

/**
 * The number of rows to draw, or null when the list is drawn whole.
 *
 * `bottoms` is each row's bottom edge measured from the top of the list, in order, with
 * every row laid out. `budget` is the height the list may take. A budget of nothing is
 * "not measured" (a test's DOM, a column not yet laid out) and limits nothing.
 *
 * `floor` is a number of rows the cut may not go above: the place of the row that holds
 * focus. The list is measured again whenever it or its column changes size, and both
 * change under someone's hands. The Android app's keyboard shrinks the page, so opening
 * it on a field near the cut moved the cut above that field; a multi-select that wraps as
 * options are added pushes its own bottom past the budget. Either way the row being
 * edited was hidden, which took its focus, which closed the keyboard, which brought the
 * row back. A row is never hidden from under the person typing in it; the cut settles
 * once focus leaves.
 */
export function rowsThatFit(bottoms: readonly number[], budget: number, floor = 0): number | null {
  if (!(budget > 0)) return null;
  let fit = 0;
  while (fit < bottoms.length && bottoms[fit]! <= budget) fit++;
  const rows = Math.max(fit, CLAMP_MIN_ROWS, floor);
  if (bottoms.length - rows < CLAMP_MIN_HIDDEN) return null;
  return rows;
}
