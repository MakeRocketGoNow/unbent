import { useEffect, useState } from 'react';

/**
 * How much of the viewport the on-screen keyboard is covering, in CSS pixels.
 *
 * `position: fixed; bottom: 0` does not do what it should on a phone: the layout viewport
 * keeps its full height when the keyboard opens, so anything pinned to the bottom is left
 * underneath it. The visual viewport is the part actually on screen, and the difference
 * between the two is the keyboard.
 *
 * Returns 0 wherever there is no keyboard, no `visualViewport` support, or nothing is
 * focused — so a caller can position against it unconditionally.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const measure = () => {
      // offsetTop matters when the page itself is scrolled up to keep the caret visible;
      // without it the bar drifts off the top of the keyboard mid-scroll.
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      // Small negative values appear during rubber-banding, and a few pixels of rounding
      // are not a keyboard. The threshold keeps a closed keyboard reading as exactly 0.
      setInset(covered > 80 ? covered : 0);
    };

    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  }, []);

  return inset;
}
