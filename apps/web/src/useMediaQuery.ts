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
 * A desktop too narrow to keep the note's property list open above its body.
 *
 * Between the phone and the full desktop the sidebar and the note share a width that a
 * 960px screen makes tight. The list of notebook, tags and fields stays where it is at
 * every width, but here it starts closed under a summary — the notebook, the tags and a
 * field count — so the body is on screen when the note opens. See the fold in `Workspace`.
 *
 * Read in JS because the list is wrapped in a `Disclosure` here and drawn bare elsewhere:
 * a different element, which CSS cannot conjure. What `useMediaQuery` guards against is
 * untouched — the list's inputs remount at the band's edges, as they already do at the
 * phone's, and the editor is not among them. The lower edge is the phone's plus one, so
 * the two can neither overlap nor leave a gap.
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
