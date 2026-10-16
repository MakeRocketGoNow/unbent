import { useCallback, useEffect, useRef, useState } from 'react';

/** How far ahead of the bottom a page is asked for: about a screen of rows on a desktop. */
export const AUTO_LOAD_MARGIN = '800px';

/**
 * Asks for the next page of a list as its Load more button nears the bottom of the
 * scroller, so a long notebook reads as one list rather than fifty notes and a button.
 *
 * Every read comes from the local copy, so a page is a slice of rows already on the
 * device; making someone press for it was paging for its own sake, and in the wide table
 * the button was easy not to see at all. The button stays, and this attaches to it: it is
 * what a keyboard reaches, what shows "Loading…" while a page arrives, and what is left to
 * press when a page fails. A failed page is not asked for again until the list changes,
 * so a refusing server is one request, not a loop, and the press is how to try again.
 *
 * The observer's root is the nearest scrolling ancestor rather than the viewport. With
 * the viewport as root the margin only reaches past the window's edge, not past the
 * list's own clipped bottom, and the page would be asked for only once the button was
 * already in sight.
 *
 * It looks again each time the list grows (`loaded`): an observer reports a change of
 * state, and a page too short to push the button out of range changes nothing, so
 * without a fresh look the list would stop one page later with the button in view.
 *
 * Returns a callback ref for the button.
 */
export function useAutoLoad(opts: {
  /** Whether a page should be asked for now: there is one, and none is on its way. */
  enabled: boolean;
  /** The rows loaded so far, so a page that arrived prompts a fresh look. */
  loaded: number;
  onLoad: () => void;
}): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  // Read at the moment the observer fires, so a change of either does not re-observe:
  // re-observing reports at once, and on `enabled` turning back on after a failed page
  // that would be the retry loop this avoids.
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && latest.current.enabled) latest.current.onLoad();
      },
      { root: scroller(el), rootMargin: `0px 0px ${AUTO_LOAD_MARGIN} 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, opts.loaded]);

  return useCallback((node: HTMLElement | null) => setEl(node), []);
}

/** The nearest ancestor that scrolls vertically, or null for the viewport. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}
