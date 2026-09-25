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

    /*
       Where `bottom: 0` actually puts a fixed element, found by putting one there.

       This used to be `window.innerHeight`, on the assumption that the two are the same
       edge. They are in Chrome, and are not in Brave on Android: Brave has a toolbar along
       the bottom of the screen that it hides when the keyboard opens, and the fixed
       containing block and `innerHeight` disagree about that toolbar's height. The docked
       bar came out one toolbar-height above the keys, with the note showing through the
       gap. Measuring the edge a caller will position against, instead of an edge that
       usually coincides with it, is right in every browser whatever its chrome does.

       Client rects and `visualViewport.offsetTop` are both relative to the layout
       viewport's top, so the two can be compared directly.
    */
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.dataset.keyboardInsetProbe = '';
    probe.style.cssText =
      'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);

    const measure = () => {
      const fixedBottom = probe.getBoundingClientRect().top;
      // offsetTop matters when the page itself is scrolled up to keep the caret visible;
      // without it the bar drifts off the top of the keyboard mid-scroll.
      const visibleBottom = vv.offsetTop + vv.height;
      const covered = fixedBottom - visibleBottom;
      // Small negative values appear during rubber-banding, and a few pixels of rounding
      // are not a keyboard. The threshold keeps a closed keyboard reading as exactly 0.
      setInset(covered > 80 ? covered : 0);
    };

    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    // Browser chrome appearing or going — Brave's bottom toolbar, a URL bar — can move the
    // fixed edge without the visual viewport's own size changing.
    window.addEventListener('resize', measure);
    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      probe.remove();
    };
  }, []);

  return inset;
}
