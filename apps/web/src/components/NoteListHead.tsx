import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { SearchIcon, FilterIcon, MenuIcon, CountChevronIcon } from './icons.js';
import { OverflowMenu, type OverflowItem } from './OverflowMenu.js';
import { BackArrow } from './BackArrow.js';

interface NoteListHeadProps {
  /**
   * "30 notes", "12 matches": built by the caller, which knows what it is counting. Null
   * when there is nothing to count (a notebook the link names that does not exist) and
   * the line is then kept empty rather than removed, so the title above it does not move
   * when the notebooks finish loading and the count turns out not to apply.
   */
  count: string | null;
  /**
   * What the count offers, when it offers anything (see `countMenuItems`). With it the
   * count is a menu trigger, "37 notes ⌄"; without it, plain text.
   *
   * The caller passes it only while `count` is a count of notes on a list that is not
   * being searched: "Loading…" and "Searching…" are not numbers anything could be done
   * to, and a search's query is not part of an export. It is a menu filtered or not:
   * one that opened only while something was filtered would hide that it ever does.
   *
   * The count rather than a control of its own because it is the one thing in this row
   * that names the slice on screen, at every width and in every view: a notebook alone
   * or a lone tag has no chips, which is why Export on the chip row did not work.
   */
  countMenu?: OverflowItem[];
  /**
   * Where the list is: the notebook's name, "Inbox", or "All notes".
   *
   * The heading this view did not have. It is what lets the topbar go on a phone: the
   * wordmark was saying which app you were in, on the one screen where that was never in
   * doubt, while the thing actually in doubt was which notebook you were looking at.
   *
   * At every width. It was the phone's alone while the desktop had a notebook picker one
   * row down, which named the notebook itself; the picker is a rail beside the column now,
   * and a rail can be a strip of icons, so the column says what it holds on its own, the
   * way Evernote heads its middle column with the notebook's name and count.
   */
  title: string;
  /**
   * A small muted line above the title, when the title alone would not say where the list
   * is: with a saved view open the title is the view's name and this is its notebook's.
   * Left out otherwise, so a plain notebook's head is exactly as tall as it was.
   */
  eyebrow?: string | undefined;
  /**
   * A menu beside the title, for what can be done to the place the title names: a saved
   * view's Rename and Delete. Drawn after the name rather than among the icons, since it
   * is about the name and not about how the list is drawn.
   */
  titleMenu?: ReactNode;
  /**
   * The title being renamed: the field that takes the name's place, in the name's own
   * line, so nothing under it moves. The row's icons step aside while it is open, as
   * they do for a phone's search, since a field sharing a phone's row with four icons
   * has no room to show what is being typed; they are back when the rename ends.
   */
  renaming?: ReactNode;
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
   * it is a permanent row under the header, which is the desktop's shape (see below).
   */
  onOpenSearch?: () => void;
  /** Closes the field *and* clears the query (see the comment on the back arrow). */
  onCloseSearch: () => void;
  onOpenFilters: () => void;
  /** The filter icon's element, which the filter panel opens over on a desktop (see `Sheet`'s `anchor`). */
  filterRef?: RefObject<HTMLButtonElement | null>;
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
   * The view menu (list, cards, table), after the sort and before New. Passed in like
   * the sort so this owns no routing and no storage.
   */
  view?: ReactNode;
  /**
   * One row instead of two, for a header that spans the whole window.
   *
   * Over the sidebar the search field is a row of its own and the notebook picker another
   * under it, which suits a 19rem column. Over the full-width table the same three rows
   * became a search field and a select each a window wide: controls sized by the space
   * they were in rather than by what they hold. So there the header is a toolbar: the
   * title and count, then a search field capped at a width a query needs, and the icons
   * and New. Only meaningful where the field is permanent; a phone's header already is
   * one row.
   */
  toolbar?: boolean;
  /**
   * The last thing in the row: the desktop's New button.
   *
   * On a phone New floats over the list, so nothing is passed here. On a desktop a
   * floating button over a column has nothing to float clear of, and the primary action
   * belongs where the old head row kept it: at the end of the row, after the controls
   * that are about what is already on screen.
   */
  action?: ReactNode;
}

/**
 * The note list's header: where you are, and the controls that are about what is on screen.
 *
 * The controls this replaces cost about half a small screen before a single note was
 * visible: a search field, two selects, a pair of date inputs and a tag row, all present
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
 * nothing. The caller says which shape it wants by passing `onOpenSearch` or not: the
 * field is then either something to open or something that is simply there.
 *
 * New is not in the row on a phone. It is a floating button over the list, which is where
 * every notes app people arrive from puts it, and it leaves this row to the four controls
 * that are about what is on screen rather than about adding to it. The desktop passes it
 * back in through `action`, at the end of the row.
 */
export function NoteListHead({
  count,
  countMenu,
  title,
  eyebrow,
  titleMenu,
  renaming,
  query,
  onQuery,
  onArrowDown,
  fieldRef,
  searchOpen,
  onOpenSearch,
  onCloseSearch,
  onOpenFilters,
  filterRef,
  onOpenMenu,
  filtered,
  sort,
  view,
  toolbar = false,
  action,
}: NoteListHeadProps) {
  const own = useRef<HTMLInputElement>(null);
  const field = fieldRef ?? own;
  /** Whether the field is a permanent row (desktop) rather than something the row opens into. */
  const fieldAlways = onOpenSearch === undefined;

  /*
   * Focus follows the field being opened, but not a field that was already open: a deep
   * link arriving with `?q=` should show its results, not the keyboard. `searchOpen` only
   * transitions here, so the effect keying off it does exactly that. A permanent field is
   * never "opened", so this never fires for it.
   */
  useEffect(() => {
    if (searchOpen && !fieldAlways) field.current?.focus();
  }, [searchOpen, fieldAlways]);

  const inToolbar = toolbar && fieldAlways;
  /*
   * The field keeps focus across the two layouts.
   *
   * The toolbar draws it inside the row and the stacked header draws it under, so a
   * change between them is a new element. The first keystroke of a search was such a
   * change while a search over the table was drawn as the list; the table and the cards
   * both keep their view for a search now, and this stays for any change of layout made
   * under a focused field, which would otherwise drop its focus mid-word. Whether it had
   * focus is read during the render that makes the change, before the old element is
   * removed; removal does not reliably fire a blur to track it by. The caret goes to the
   * end, where typing left it.
   */
  const lastLayout = useRef(inToolbar);
  const refocus = useRef(false);
  if (lastLayout.current !== inToolbar) {
    lastLayout.current = inToolbar;
    refocus.current = typeof document !== 'undefined' && document.activeElement === field.current;
  }
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [inToolbar]);

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
        // permanent field that means clearing it: there is nothing to close.
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
     * that made the search row taller than the closed header, so opening search pushed
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
          data-tip="Close search"
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
      <div className={inToolbar ? 'list-head list-head-toolbar' : 'list-head'}>
        {onOpenMenu && (
          <button type="button" className="icon-btn" aria-label="Notebooks" data-tip="Notebooks" onClick={onOpenMenu}>
            <MenuIcon />
          </button>
        )}
        {/* Two lines in one column: where you are, and how much of it there is. The count
            was the whole header before, which said how many without ever saying of what.
            The title is the notebook's own name, which can outrun a narrow column; the
            tooltip carries what the ellipsis drops. */}
        <div className="list-title">
          {eyebrow && (
            <span className="list-eyebrow" title={eyebrow}>
              {eyebrow}
            </span>
          )}
          {renaming ??
            (titleMenu ? (
              <div className="list-title-row">
                <h2 title={title}>{title}</h2>
                {titleMenu}
              </div>
            ) : (
              <h2 title={title}>{title}</h2>
            ))}
          {count === null ? (
            <span className="count" aria-hidden="true">
              {'\u00a0'}
            </span>
          ) : countMenu ? (
            /* Same type size and place as the plain count, so nothing moves when it
               becomes one; the chevron and the hover fill are what say it opens. A bare
               number that happened to open a menu was the version rejected before. */
            <OverflowMenu
              label={`${count}, export or select`}
              items={countMenu}
              className="count-menu"
              triggerClassName="count-trigger"
              trigger={
                <>
                  <span className="count-text">{count}</span>
                  <CountChevronIcon />
                </>
              }
            />
          ) : (
            <span className="count">{count}</span>
          )}
        </div>
        {inToolbar && !renaming && <div className="list-search">{input}</div>}
        {!renaming && (
          <div className="list-head-actions">
            {onOpenSearch && (
              <button type="button" className="icon-btn" aria-label="Search notes" data-tip="Search notes" onClick={onOpenSearch}>
                <SearchIcon />
              </button>
            )}
            <button
              ref={filterRef}
              type="button"
              className="icon-btn"
              /*
               * The state goes in the name, not only in the dot. The dot is the glanceable half
               * and it is invisible to a screen reader; a control that reads "Filter notes"
               * either way would leave the one fact worth knowing (that the list is already
               * narrowed) available to sighted users alone.
               */
              aria-label={filtered ? 'Filter notes, filters are active' : 'Filter notes'}
              data-tip={filtered ? 'Filter notes, some are on' : 'Filter notes'}
              onClick={onOpenFilters}
            >
              <FilterIcon />
              {filtered && <span className="badge-dot" aria-hidden="true" />}
            </button>
            {sort}
            {view}
            {action}
          </div>
        )}
      </div>
      {fieldAlways && !inToolbar && <div className="list-search">{input}</div>}
    </>
  );
}
