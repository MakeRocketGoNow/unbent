import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState, useSearch } from '@tanstack/react-router';
import { AccountMenu } from './AccountMenu.js';
import { InstanceRibbon } from './InstanceRibbon.js';
import { notebooksQuery, tagsQuery, trashCountQuery } from '../queries.js';
import { useMediaQuery, RAIL_WIDE_QUERY } from '../useMediaQuery.js';
import { NotebookNav, type NavPlace } from './NotebookNav.js';
import { ResizeHandle } from './ResizeHandle.js';
import { usePersistentState, clamp } from '../usePersistentState.js';

/**
 * The open rail's width, in px: 15rem at the root font size, between 11rem and 20rem.
 *
 * Below 11rem the labels stop being labels, and the strip is what "small" means here;
 * above 20rem the rail is eating the note, and a longer name is what the tooltip is for.
 * A drag that goes on past the floor collapses the rail instead of stopping at it — the
 * gesture Apple Notes and Evernote both honour — so the toggle is the discoverable way
 * to a strip and the drag is the fast one, with no dead zone between them.
 */
export const RAIL_DEFAULT = 240;
export const RAIL_MIN = 176;
export const RAIL_MAX = 320;
/** Dragging or stepping under this collapses the rail rather than clamping. */
export const RAIL_COLLAPSE_BELOW = 144;
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
  email: string;
  onSignOut: () => void;
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
 * the strip because they all share one glyph.
 *
 * Open, its width is dragged, like the list's — see `useRailWidth`. It was fixed at
 * first, on the reasoning that one drag handle on the screen was enough and a rail's
 * width is its labels' width; the labels are notebook and tag names, which are anyone's
 * length, and every three-column app this is compared against lets the first column be
 * sized. The strip is not draggable: it is the width of its icons.
 *
 * It also took over what the desktop's top bar held — the wordmark, the way to Settings,
 * the account — which retired that bar above the breakpoint and gave every screen its
 * height back. Settings is a row on the floor rather than an item in the account menu,
 * as it was a gear beside the avatar before: the two are different kinds of thing, the
 * row is about the app and the menu about the account, and Keep draws exactly this
 * pair. It also keeps the desktop honest with the phone, where Settings is the same row
 * on the drawer's floor — one click at both widths, never a menu to open first. The
 * account sits under Settings, on the floor, rather than in the head beside the
 * wordmark as it does in the drawer: the strip's head has room for one control, which
 * has to be the way to expand it, and the floor is outside the scrolling rows, so the
 * menu it opens is never clipped by them.
 */
export function Rail({ pref, onPref, email, onSignOut }: RailProps) {
  const notebooks = useQuery(notebooksQuery());
  const trashCount = useQuery(trashCountQuery());
  const tags = useQuery(tagsQuery());
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
      <InstanceRibbon placement="rail" />
      <div className="rail-inner">
        <div className="rail-head">
          {/* The wordmark, as it was in the top bar: a link home. Gone in the strip —
              hidden rather than clipped, so it is not an invisible stop on the Tab path. */}
          <h1 className="rail-wordmark">
            <Link to="/notes" className="plain">
              Unbent
            </Link>
          </h1>
          <button
            type="button"
            className="icon-btn rail-toggle"
            aria-expanded={open}
            aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
            data-tip={open ? 'Collapse sidebar' : 'Expand sidebar'}
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
          tags={tags.data ?? []}
          labelsHidden={!open}
          footer={<AccountMenu email={email} onSignOut={onSignOut} withAddress />}
        />
      </div>
    </aside>
  );
}

/**
 * The open rail's dragged width: the live value, and the stored one it settles to.
 *
 * The same split the list's width makes (`useNotesLayout`): a drag re-renders without
 * writing, and the release writes once. The width reaches the stylesheet as a custom
 * property on the shell rather than on the rail, because the filter panel — in the top
 * layer, and positioned past the rail — can only inherit it from a shared ancestor. It is
 * consumed only while the rail is open; the strip's width is the stylesheet's own.
 */
export function useRailWidth() {
  const [stored, setStored] = usePersistentState('railWidth', RAIL_DEFAULT, (raw) =>
    typeof raw === 'number' && raw >= RAIL_MIN && raw <= RAIL_MAX ? raw : undefined,
  );
  const [width, setWidth] = useState(stored);
  useEffect(() => setWidth(stored), [stored]);
  return {
    width,
    style: { '--rail-open-width': `${width}px` } as React.CSSProperties,
    /** Every pointermove: state only. Clamped, so the rail never draws narrower than its floor mid-drag. */
    onResize: (next: number) => setWidth(clamp(next, RAIL_MIN, RAIL_MAX)),
    /**
     * Release, arrow key, or reset. A value past the floor is a request to collapse, not a
     * width; the caller decides what collapsing means, since it owns the rail's state.
     */
    onCommit: (next: number, collapse: () => void) => {
      if (next < RAIL_COLLAPSE_BELOW) {
        setWidth(stored);
        collapse();
        return;
      }
      setStored(clamp(next, RAIL_MIN, RAIL_MAX));
    },
  };
}

interface RailHandleProps {
  /** The shell row the rail sits in: what the pointer is measured against. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  width: ReturnType<typeof useRailWidth>;
  /** Collapses the rail; a drag past the floor asks for this. */
  onCollapse: () => void;
}

/**
 * The divider between the rail and the content, and the handle that sizes the rail.
 *
 * A sibling of the rail in the shell's row, as the list's handle is a sibling in the
 * grid, so its geometry is measured against what it divides. The rail's own edge is
 * drawn by this line while it shows; the stylesheet hides it over the strip and gives the
 * rail its border back there, so there is one line either way.
 */
export function RailHandle({ containerRef, width, onCollapse }: RailHandleProps) {
  return (
    <ResizeHandle
      label="Resize navigation"
      containerRef={containerRef}
      // The rail starts at the row's left edge and the handle sits flush on it, so the
      // pointer's distance from the row's edge is the width itself.
      toValue={(clientX, rect, gap) => clientX - rect.left - gap}
      value={width.width}
      min={RAIL_MIN}
      max={RAIL_MAX}
      step={16}
      defaultValue={RAIL_DEFAULT}
      onResize={width.onResize}
      onCommit={(next) => width.onCommit(next, onCollapse)}
    />
  );
}
