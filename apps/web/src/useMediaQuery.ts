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

/** The phone breakpoint. Kept beside the query below so the two edges cannot drift. */
export const MOBILE_QUERY = '(max-width: 860px)';

/**
 * A desktop too narrow for the fields' column.
 *
 * Between the phone and the full desktop is a width where the sidebar, the note and a
 * 19rem fields column do not fit: at 960px the editor was left about 250px, its toolbar
 * wrapped to five rows and its title truncated to a dozen characters. The sidebar is how
 * notes are reached and the note is what the screen is for, so the fields are what give
 * way — they fold above the body, closed until asked. See the fold in `Workspace`.
 *
 * Read in JS because the fields move between two containers, not because the layout is
 * JS-driven: the column is a sibling of the note's column and the fold sits inside it, and
 * CSS cannot reparent. What `useMediaQuery` guards against is untouched — the fields'
 * inputs remount at the edges, as they already do at the phone's, and the editor is not
 * among them. The upper edge is where three columns stop being cramped; the lower is the
 * phone's plus one, so the two can neither overlap nor leave a gap.
 */
export const NARROW_DESKTOP_QUERY = '(min-width: 861px) and (max-width: 1080px)';

/**
 * Whether this is a touch device, which is to say: whether focusing something raises a
 * software keyboard over half the screen.
 *
 * Not a width. `MOBILE_QUERY` answers "is the layout narrow", and the two part company in
 * both directions — a tablet at 1024px has a software keyboard, and a desktop window
 * dragged narrow has none. Autofocus is a question about the keyboard, so it asks this.
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
