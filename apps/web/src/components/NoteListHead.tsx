import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
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
   *
   * Absent at desktop width, where the notebook picker sits one row down and names the
   * notebook itself; a heading above it would be the same word twice on adjacent lines.
   */
  title?: string;
  /** The search box's value, which is the URL's `q`. */
  query: string;
  onQuery: (next: string) => void;
  /**
   * Arrow Down in the field, which is how the results under it are reached by keyboard.
   * The caller moves focus into its list; the field itself has nothing below to offer.
   */
  onArrowDown?: () => void;
  /** The field's element, for a caller that needs to put focus back on it. */
  fieldRef?: RefObject<HTMLInputElement | null>;
  /** Whether the field has taken over the row. Ignored when the field is always on screen. */
  searchOpen: boolean;
  /**
   * Opens the field over the row. When absent, the field is not behind an icon at all:
   * it is a permanent row under the header, which is the desktop's shape — see below.
   */
  onOpenSearch?: () => void;
  /** Closes the field *and* clears the query — see the comment on the back arrow. */
  onCloseSearch: () => void;
  onOpenFilters: () => void;
  /** Opens the drawer of notebooks. Absent where there is no drawer. */
  onOpenMenu?: () => void;
  /** Lights the dot on the filter icon: a narrowed list should never look like the whole archive. */
  filtered: boolean;
  /**
   * The sort control, or nothing while searching. Passed in so this owns no routing.
   *
   * It was a ⋯ menu carrying sort *and* Settings, because this row was the only chrome on
   * the phone's list and Settings had nowhere else to be. Settings is a row on the drawer's
   * floor now, so the corner goes back to the control people reach for daily.
   */
  sort: ReactNode;
  /**
   * The last thing in the row: the desktop's New button.
   *
   * On a phone New floats over the list, so nothing is passed here. On a desktop a
   * floating button over a column has nothing to float clear of, and the primary action
   * belongs where the old head row kept it — at the end of the row, after the controls
   * that are about what is already on screen.
   */
  action?: ReactNode;
}

/**
 * The note list's header: where you are, and the controls that are about what is on screen.
 *
 * The controls this replaces cost about half a small screen before a single note was
 * visible — a search field, two selects, a pair of date inputs and a tag row, all present
 * on every visit and most of them used on few. They are all still here; they are one tap
 * away instead of permanently open, which is the trade the Android app makes and the one
 * every notes app people arrive from has settled on.
 *
 * It was the phone's alone, on the reasoning that a desktop sidebar had room for the
 * controls themselves. It had room for them and nothing else: on a 19rem column those
 * rows left the note list a few entries tall, on the screen whose entire job is listing
 * notes. So the desktop takes this row too, and the difference between the two widths
 * is two props rather than two headers.
 *
 * **Search on a phone takes the whole row**, because a field sharing a 375px row with four
 * controls is a field you cannot read what you typed into. That is also why the arrow
 * that closes it clears the query: a closed field with a live `q` is a list filtered by
 * something invisible, which is the failure this whole change is about. The Android app's
 * search bar does the same.
 *
 * **Search on a desktop is a permanent row under the header.** It is the one control used
 * on most visits, the column has the width for it, and every notes app with a desktop
 * keeps its search visible there; putting it behind an icon would trade a click for
 * nothing. The caller says which shape it wants by passing `onOpenSearch` or not — the
 * field is then either something to open or something that is simply there.
 *
 * New is not in the row on a phone. It is a floating button over the list, which is where
 * every notes app people arrive from puts it, and it leaves this row to the four controls
 * that are about what is on screen rather than about adding to it. The desktop passes it
 * back in through `action`, at the end of the row.
 */
export function NoteListHead({
  count,
  title,
  query,
  onQuery,
  onArrowDown,
  fieldRef,
  searchOpen,
  onOpenSearch,
  onCloseSearch,
  onOpenFilters,
  onOpenMenu,
  filtered,
  sort,
  action,
}: NoteListHeadProps) {
  const own = useRef<HTMLInputElement>(null);
  const field = fieldRef ?? own;
  /** Whether the field is a permanent row (desktop) rather than something the row opens into. */
  const fieldAlways = onOpenSearch === undefined;

  /*
   * Focus follows the field being opened, but not a field that was already open — a deep
   * link arriving with `?q=` should show its results, not the keyboard. `searchOpen` only
   * transitions here, so the effect keying off it does exactly that. A permanent field is
   * never "opened", so this never fires for it.
   */
  useEffect(() => {
    if (searchOpen && !fieldAlways) field.current?.focus();
  }, [searchOpen, fieldAlways]);

  const input = (
    <input
      ref={field}
      className="search-field"
      type="search"
      value={query}
      placeholder="Search notes…"
      aria-label="Search notes"
      onChange={(e) => onQuery(e.target.value)}
      onKeyDown={(e) => {
        // Escape leaves the search the way it does everywhere else in the app. For the
        // permanent field that means clearing it — there is nothing to close.
        if (e.key === 'Escape') onCloseSearch();
        // Arrow Down goes to the results, the way it does in Apple Notes and Finder: the
        // list under the field is what the typing produced, and a search should be one
        // keyboard path from the first keystroke to the note.
        if (e.key === 'ArrowDown' && onArrowDown) {
          e.preventDefault();
          onArrowDown();
        }
      }}
    />
  );

  if (searchOpen && !fieldAlways) {
    /*
     * One row, the same height as the row it replaces.
     *
     * The count is deliberately not here. It was, on a second line under the field, and
     * that made the search row taller than the closed header — so opening search pushed
     * the whole note list down and closing it pulled the list back up. Motion the user did
     * not ask for reads as jank, and it was happening on the most-used control in the view.
     *
     * Nothing is lost by dropping it: the results are the answer, and the list underneath
     * is showing them. A count is worth a line when it describes something you cannot see
     * all of, which is the closed header's job, not this one's.
     */
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
        {input}
      </div>
    );
  }

  return (
    <>
      <div className="list-head">
        {onOpenMenu && (
          <button type="button" className="icon-btn" aria-label="Notebooks" onClick={onOpenMenu}>
            <MenuIcon />
          </button>
        )}
        {/* Two lines in one column: where you are, and how much of it there is. The count
            was the whole header before, which said how many without ever saying of what.
            Without a title it is the count alone again — at desktop width the notebook
            picker under this row is what says of what. */}
        <div className="list-title">
          {title && <h2>{title}</h2>}
          <span className="count">{count}</span>
        </div>
        <div className="list-head-actions">
          {onOpenSearch && (
            <button type="button" className="icon-btn" aria-label="Search notes" onClick={onOpenSearch}>
              <SearchIcon />
            </button>
          )}
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
          {sort}
          {action}
        </div>
      </div>
      {fieldAlways && <div className="list-search">{input}</div>}
    </>
  );
}
