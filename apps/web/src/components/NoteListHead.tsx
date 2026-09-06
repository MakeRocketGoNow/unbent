import { useEffect, useRef, type ReactNode } from 'react';
import { SearchIcon, FilterIcon, MenuIcon } from './icons.js';
import { BackArrow } from './BackArrow.js';

interface NoteListHeadProps {
  /** "30 notes", "12 matches" — built by the caller, which knows what it is counting. */
  count: string;
  /**
   * Where the list is: the notebook's name, "Inbox", or "All notes".
   *
   * The heading this view did not have. It is what lets the topbar go on a phone — the
   * wordmark was saying which app you were in, on the one screen where that was never in
   * doubt, while the thing actually in doubt was which notebook you were looking at.
   */
  title: string;
  /** The search box's value, which is the URL's `q`. */
  query: string;
  onQuery: (next: string) => void;
  /** Whether the field has taken over the row. */
  searchOpen: boolean;
  onOpenSearch: () => void;
  /** Closes the field *and* clears the query — see the comment on the back arrow. */
  onCloseSearch: () => void;
  onOpenFilters: () => void;
  /** Opens the drawer of notebooks. */
  onOpenMenu: () => void;
  /** Lights the dot on the filter icon: a narrowed list should never look like the whole archive. */
  filtered: boolean;
  /** The sort menu, hidden while searching. Passed in so this component owns no routing. */
  sortMenu: ReactNode;
}

/**
 * The note list's header on a phone: a count, three icons and New.
 *
 * The controls these replace cost about half a small screen before a single note was
 * visible — a search field, two selects, a pair of date inputs and a tag row, all present
 * on every visit and most of them used on few. They are all still here; they are one tap
 * away instead of permanently open, which is the trade the Android app makes and the one
 * every notes app people arrive from has settled on.
 *
 * Search takes the whole row rather than sitting beside the icons, because a field sharing
 * a 375px row with four controls is a field you cannot read what you typed into. That is
 * also why the arrow that closes it clears the query: a closed field with a live `q` is a
 * list filtered by something invisible, which is the failure this whole change is about.
 * The Android app's search bar does the same.
 *
 * New is not here. It is a floating button over the list, which is where every notes app
 * people arrive from puts it, and it leaves this row to the four controls that are about
 * what is on screen rather than about adding to it.
 *
 * Above the breakpoint none of this renders — the sidebar has room for the controls
 * themselves, and one-click filtering there is a strength rather than clutter.
 */
export function NoteListHead({
  count,
  title,
  query,
  onQuery,
  searchOpen,
  onOpenSearch,
  onCloseSearch,
  onOpenFilters,
  onOpenMenu,
  filtered,
  sortMenu,
}: NoteListHeadProps) {
  const field = useRef<HTMLInputElement>(null);

  /*
   * Focus follows the field being opened, but not a field that was already open — a deep
   * link arriving with `?q=` should show its results, not the keyboard. `searchOpen` only
   * transitions here, so the effect keying off it does exactly that.
   */
  useEffect(() => {
    if (searchOpen) field.current?.focus();
  }, [searchOpen]);

  if (searchOpen) {
    return (
      <div className="list-search">
        <button
          type="button"
          className="icon-btn"
          // "Close search" would describe the chrome; this describes the effect, which is
          // the part that is not obvious from an arrow.
          aria-label="Close search and clear the query"
          onClick={onCloseSearch}
        >
          <BackArrow />
        </button>
        <input
          ref={field}
          className="search-field"
          type="search"
          value={query}
          placeholder="Search notes…"
          aria-label="Search notes"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape leaves the search the way it does everywhere else in the app.
            if (e.key === 'Escape') onCloseSearch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="list-head">
      <button
        type="button"
        className="icon-btn"
        aria-label="Notebooks"
        onClick={onOpenMenu}
      >
        <MenuIcon />
      </button>
      {/* Two lines in one column: where you are, and how much of it there is. The count
          was the whole header before, which said how many without ever saying of what. */}
      <div className="list-title">
        <h2>{title}</h2>
        <span className="count">{count}</span>
      </div>
      <div className="list-head-actions">
        <button type="button" className="icon-btn" aria-label="Search notes" onClick={onOpenSearch}>
          <SearchIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          /*
           * The state goes in the name, not only in the dot. The dot is the glanceable half
           * and it is invisible to a screen reader; a control that reads "Filter notes"
           * either way would leave the one fact worth knowing — that the list is already
           * narrowed — available to sighted users alone.
           */
          aria-label={filtered ? 'Filter notes, filters are active' : 'Filter notes'}
          onClick={onOpenFilters}
        >
          <FilterIcon />
          {filtered && <span className="badge-dot" aria-hidden="true" />}
        </button>
        {sortMenu}
      </div>
    </div>
  );
}
