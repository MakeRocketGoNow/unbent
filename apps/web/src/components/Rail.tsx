import { useQuery } from '@tanstack/react-query';
import { useRouterState, useSearch } from '@tanstack/react-router';
import { notebooksQuery, trashCountQuery } from '../queries.js';
import { useMediaQuery, RAIL_WIDE_QUERY } from '../useMediaQuery.js';
import { NotebookNav, type NavPlace } from './NotebookNav.js';
import { RailToggleIcon } from './icons.js';

/**
 * How the rail is drawn, as the user last chose it — or `auto` until they have.
 *
 * Three states rather than a boolean, because a wide window and a narrow one want
 * different defaults: at 1440px the open rail is what a desktop app looks like, and at
 * 1024px it leaves the note narrower than a phone. `auto` lets the stylesheet pick by
 * width; the first click on the toggle settles it for every width, and nothing in the UI
 * puts it back — a chosen layout should not undo itself when a window is resized.
 */
export type RailPref = 'auto' | 'open' | 'collapsed';

interface RailProps {
  pref: RailPref;
  onPref: (next: RailPref) => void;
}

/** Which screen the rail is beside, from the path the router has actually committed to. */
function placeOf(pathname: string): NavPlace {
  if (pathname.startsWith('/trash')) return 'trash';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/notes')) return 'notes';
  return 'other';
}

/**
 * The desktop's navigation: the phone's drawer, pinned open down the left.
 *
 * The notes sidebar used to be two things at once — where you are (a notebook select,
 * and Trash on its floor) and the list of what is there. That held while the list was the
 * narrowest thing on screen. The table view made it the widest, and everything parked in
 * it stretched with it: a select a window wide, Trash orphaned under a table. So the
 * navigation gets a column of its own, the way Evernote, Keep and Apple Notes give it
 * one, and the list column goes back to being the list.
 *
 * It is the drawer's rows exactly (`NotebookNav`), so the phone and the desktop agree
 * about what the places are and what picking one does. What differs is only that this
 * surface is always on screen: picking a scope closes nothing, and the rows are marked
 * by which screen they stand beside, Trash and Settings included, since this is on
 * those screens too and is the only way back from them once the top bar goes.
 *
 * A sibling of the routed content in the shell, not a fourth track in the notes grid.
 * The grid keeps the open note above a floor by subtracting from its own width, and
 * measures its drag handle against its own edges; a track added in front of the sidebar
 * would silently shrink that floor and shift that measurement. And the trash and settings
 * screens have grids of their own — the rail has to stand beside whichever is there.
 *
 * Collapsed, it is a strip of icons rather than nothing: the way to expand it again, the
 * places that have a glyph of their own, Trash, Settings, and the account, all still one
 * click away on every screen, with no drawer over a desktop. The notebooks drop out of
 * the strip because they all share one glyph. Not resizable: one drag handle on the
 * screen is enough, and a rail's width is its labels' width.
 */
export function Rail({ pref, onPref }: RailProps) {
  const notebooks = useQuery(notebooksQuery());
  const trashCount = useQuery(trashCountQuery());
  /*
   * The notes' search params, from wherever the rail is standing. `/notes` is the only
   * route that validates them; from the trash or settings there is no such match and this
   * is undefined, which is right — no place is current there.
   */
  const search = useSearch({ from: '/notes', shouldThrow: false });
  const place = useRouterState({
    select: (s) => placeOf((s.resolvedLocation ?? s.location).pathname),
  });

  const wide = useMediaQuery(RAIL_WIDE_QUERY);
  const open = pref === 'auto' ? wide : pref === 'open';

  return (
    <aside className="rail" aria-label="Navigation">
      <div className="rail-inner">
        <div className="rail-head">
          <button
            type="button"
            className="icon-btn rail-toggle"
            aria-expanded={open}
            aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
            title={open ? 'Collapse sidebar' : 'Expand sidebar'}
            onClick={() => onPref(open ? 'collapsed' : 'open')}
          >
            <RailToggleIcon open={open} />
          </button>
        </div>
        <NotebookNav
          place={place}
          notebook={search?.notebook}
          selectedTags={search?.tag ?? []}
          notebooks={notebooks}
          trashed={trashCount.data ?? 0}
          labelsHidden={!open}
        />
      </div>
    </aside>
  );
}
