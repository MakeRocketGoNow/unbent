import { useEffect, useState } from 'react';
import { refiledLocallyWithin } from '../store/actions.js';
import { prefersReducedMotion } from '../useMediaQuery.js';

/** How long one roll takes; `.count-roll` in the stylesheet is written to it. */
export const ROLL_MS = 300;

/**
 * How long after a write here a count that changes is taken to have changed because of it.
 * Long enough for the write to come back through the collections and be drawn.
 */
const MINE_MS = 1500;

interface RollingCountProps {
  value: number;
  className?: string;
}

/**
 * A count that rolls to its new number when the person's own action changed it.
 *
 * File a note and the notebook it went to ticks up while the one it left ticks down, the
 * way an odometer turns: a larger number comes up from below, a smaller one down from
 * above. It ties the action to its consequence on the other side of the screen, which a
 * number that silently changed did not.
 *
 * Only for a change made here (`refiledLocallyWithin`). The first copy of a library, and the
 * feed bringing another device's changes, move counts too, sometimes hundreds of times in
 * a minute; rolling for those would be a column of numbers flickering at someone who did
 * nothing. A count drawn for the first time, on load, has nothing to roll from.
 *
 * Both numbers are drawn while it turns, the old one on its way out, which is why the old
 * one is held for one roll's length after the value moves on. Hidden from a screen
 * reader, which hears the new number alone. With reduced motion asked for it simply
 * changes, as it always did.
 */
export function RollingCount({ value, className }: RollingCountProps) {
  const [shown, setShown] = useState(value);
  const [leaving, setLeaving] = useState<{ value: number; up: boolean } | null>(null);
  // Which roll this is, so each one's numbers are new elements and their animations run.
  const [turn, setTurn] = useState(0);

  if (value !== shown) {
    const rolls = refiledLocallyWithin(MINE_MS) && !prefersReducedMotion();
    setLeaving(rolls ? { value: shown, up: value > shown } : null);
    if (rolls) setTurn((t) => t + 1);
    setShown(value);
  }

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), ROLL_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const way = leaving?.up ? 'up' : 'down';
  return (
    <span className={className ? `count-roll ${className}` : 'count-roll'}>
      {leaving && (
        <span key={`out-${turn}`} className={`count-out ${way}`} aria-hidden="true">
          {leaving.value}
        </span>
      )}
      <span key={`in-${turn}`} className={leaving ? `count-in ${way}` : undefined}>
        {shown}
      </span>
    </span>
  );
}
