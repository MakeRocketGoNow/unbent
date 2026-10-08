import { useEffect, useState, type ReactNode } from 'react';

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

  useEffect(() => {
    if (open || !present) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => setPresent(false), reduced ? 0 : COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  if (!present) return null;
  return (
    <div id={id} className={open ? 'collapse open' : 'collapse'} inert={!open}>
      {/* The clip is what the row shrinks; the content inside keeps its own padding and
          margins, which a box shrunk to nothing would otherwise still show. */}
      <div className="collapse-clip">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
