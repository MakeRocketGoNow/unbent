/**
 * Back arrow for leaving a full-screen view.
 *
 * An SVG icon rather than the `←` character this used to be. The Unicode arrow rendered
 * at different weights and baselines across browsers and OS fonts, making it look smaller
 * than the overflow menu's `⋯` on the opposite side of the same row. A drawn path inherits
 * `currentColor` and the containing element's size consistently, so the two controls now
 * match.
 *
 * Sized at 1.35em to fill the touch target better than a 1em glyph does. The viewBox is
 * 24×24 like the toolbar icons, and the path is a simple chevron: two lines meeting at
 * the midpoint, the conventional "go back" shape every platform uses.
 */
export function BackArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.35em"
      height="1.35em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
