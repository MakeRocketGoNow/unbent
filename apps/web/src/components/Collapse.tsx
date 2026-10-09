import { useEffect, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../useMediaQuery.js';

/** How long opening and closing take; `.collapse` in the stylesheet is written to it. */
export const COLLAPSE_MS = 250;

interface CollapseProps {
  open: boolean;
  children: ReactNode;
  /** On the outer box, for the control that opens it to name with `aria-controls`. */
  id?: string;
  /** On the box the content lays itself out in — the rows' own flex or grid. */
  className?: string;
}

/**
 * Content a control opens and closes, growing to its height and shrinking from it rather
 * than appearing in one frame.
 *
 * A section that snaps open moves everything under it by its whole height at once, which
 * reads as the page jumping; growing over a quarter of a second, the content below is seen
 * to be pushed rather than replaced. The `<details>` elements get the same from the
 * stylesheet alone (`::details-content`); this is for the disclosures that are a button and
 * a state, which a stylesheet cannot see closing.
 *
 * That is why the content is kept for one closing's length after `open` goes false: a
 * removed element has nothing left to shrink. It is mounted only while open or closing, so
 * a fold of four hundred unchanged lines costs nothing until it is opened, as it did when
 * it was a plain `open &&`. While closing it is `inert`, so focus and a screen reader leave
 * it with the click rather than a quarter-second later.
 *
 * Drawn with the grid-rows technique — one row that goes between `0fr` and `1fr` — which
 * every current browser animates, rather than `height: auto` and `interpolate-size`, which
 * not all do. With reduced motion asked for it opens and closes at once.
 */
export function Collapse({ open, children, id, className }: CollapseProps) {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  /*
   * Whether an open grows. Not when it is drawn open in the first place: the sidebar's Tags
   * remembers being open, and growing a list hundreds of pixels tall on every page load,
   * and every time the drawer opens, is the jump this exists to remove. Once it has been
   * closed, every open is the person's, and grows.
   */
  const [grows, setGrows] = useState(!open);
  if (!open && !grows) setGrows(true);

  useEffect(() => {
    if (open || !present) return;
    const timer = window.setTimeout(() => setPresent(false), prefersReducedMotion() ? 0 : COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  if (!present) return null;
  return (
    <div id={id} className={['collapse', open && 'open', grows && 'grows'].filter(Boolean).join(' ')} inert={!open}>
      {/* The clip is what the row shrinks; the content inside keeps its own padding and
          margins, which a box shrunk to nothing would otherwise still show. */}
      <div className="collapse-clip">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
