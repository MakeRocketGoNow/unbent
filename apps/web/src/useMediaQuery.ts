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

/**
 * The phone breakpoint: one pane at a time, driven by the URL. Below this the sidebar and
 * the note are never on screen together — see the phone block in `styles.css`.
 */
export const MOBILE_QUERY = '(max-width: 860px)';

/**
 * The width below which the sidebar cannot share the row with an open note and its fields.
 *
 * Between this and `MOBILE_QUERY` is the middle band: too narrow for three columns, too wide
 * to give up the note-beside-its-fields layout the way a phone does. There the sidebar
 * becomes a drawer *while a note is open* — the list slides off, the note and its fields
 * take the reclaimed width, and the ☰ brings the list back. The list view itself keeps the
 * sidebar in place, since a list hidden in a drawer is a list view with nothing in it.
 *
 * The number is where the three-column layout stops being comfortable: a 304px sidebar, a
 * 304px fields column, their margins, and enough left for the editor's toolbar to hold its
 * twelve controls in one row rather than wrapping to five. Below it the editor was ~250px of
 * a 960px screen. Kept beside `MOBILE_QUERY` so the two edges of the band cannot drift.
 *
 * Read in JS only to drive the drawer's open/close state and its scrim; the layout itself is
 * CSS, keyed on `.note-open` the same way the phone block is, so nothing here remounts the
 * editor across the band.
 */
export const RAIL_DRAWER_QUERY = '(min-width: 861px) and (max-width: 1080px)';

/**
 * Whether this is a touch device, which is to say: whether focusing something raises a
 * software keyboard over half the screen.
 *
 * Not a width. `MOBILE_QUERY` answers "is the layout narrow", and the two part company in
 * both directions — a tablet at 1024px has a software keyboard, and a desktop window
 * dragged narrow has none. Autofocus is a question about the keyboard, so it asks this.
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
