import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a media query.
 *
 * The layout is deliberately CSS-driven — nothing here swaps component trees at a
 * breakpoint, because the editor is an uncontrolled CodeMirror view that must not be
 * rebuilt. This exists for the narrow case CSS cannot cover: a control whose *meaning*
 * changes with width, where the icon and the accessible name have to say which of two
 * things the next tap will do.
 *
 * `useSyncExternalStore` rather than useState + useEffect: it reads the current match
 * during render, so the first paint is already correct instead of flashing the desktop
 * state on a phone.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    // Server/prerender has no viewport; the desktop layout is the wider default.
    () => false,
  );
}

/** The one breakpoint in the app. Kept beside the query so the two cannot drift. */
export const MOBILE_QUERY = '(max-width: 860px)';

/**
 * Where the desktop's navigation rail opens by itself.
 *
 * The stylesheet decides the rail's width from this same number, in range syntax, so
 * that a window is never in both bands at once. JS reads it in exactly one place — the
 * rail's collapse button — because that control's name and icon say what the next click
 * will do, and until the user has chosen, what it will do depends on which side of this
 * the window is. Everything else about the rail is CSS.
 */
export const RAIL_WIDE_QUERY = '(width >= 1200px)';

/**
 * Whether this is a touch device, which is to say: whether focusing something raises a
 * software keyboard over half the screen.
 *
 * Not a width. `MOBILE_QUERY` answers "is the layout narrow", and the two part company in
 * both directions — a tablet at 1024px has a software keyboard, and a desktop window
 * dragged narrow has none. Autofocus is a question about the keyboard, so it asks this.
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
