import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { UNFILED } from '@unbent/shared';
import * as api from '../notes-api.js';
import { Route } from '../routes/notes.js';
import {
  notesQuery,
  tagsQuery,
  notebooksQuery,
  searchQuery,
  trashCountQuery,
  invalidateNoteMembership,
} from '../queries.js';
import { useNotesLayout, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from '../useNotesLayout.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem } from './NoteListItem.js';
import { useListKeys } from '../useListKeys.js';
import { markNewNote } from '../useNewNote.js';
import { SearchResults } from './SearchResults.js';
import { IndexingStatus } from './IndexingStatus.js';
import { Button } from './Button';
import { NotebookSelect } from './NotebookSelect.js';
import { SortSelect } from './SortSelect.js';
import { DateRange } from './DateRange.js';
import { ExportLink } from './ExportLink.js';
import { TagFilter } from './TagFilter.js';
import { TagPicker } from './TagPicker.js';
import { FilterRow } from './FilterRow.js';
import { DatePicker } from './DatePicker.js';
import { rangeLabel } from './format-when.js';
import { NotebookDrawer } from './NotebookDrawer.js';
import { PlusIcon, TagIcon, CalendarIcon } from './icons.js';
import { Sheet } from './Sheet.js';
import { NoteListHead } from './NoteListHead.js';
import { NotesSort } from './NotesSort.js';
import { ActiveFilters } from './ActiveFilters.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { useSession } from '../auth-client.js';
import { useSignOut } from '../useSignOut.js';

/** Sidebar plus the routed workspace. Filters come from the URL; nothing here is mirrored into state. */
export function NotesLayout({ children }: { children: React.ReactNode }) {
  const { notebook, tag, q = '', sort, order, from, to } = Route.useSearch();
  /** The tag filter as a list, so the sidebar never has to care that it may be absent. */
  const selectedTags = tag ?? [];
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const layout = useNotesLayout('/notes/$noteId');
  const onListKeys = useListKeys();
  /*
   * The account, for the drawer's floor. The topbar carries it at desktop width and is
   * hidden over the phone's list, so this is where it is reached there — the root layout
   * has already established the session by the time this renders.
   */
  const { data: session } = useSession();
  const signOutAndLeave = useSignOut();

  const filter = {
    ...(notebook ? { notebook } : {}),
    ...(tag ? { tag } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const ordering = { ...(sort ? { sort } : {}), ...(order ? { order } : {}) };

  /**
   * The export link is the current filter, serialized. Because the filters already live in
   * the URL there is no separate state to keep in step — the link is the view.
   */
  const isFiltered = Boolean(notebook || selectedTags.length || from || to);

  /*
   * What the filter icon speaks for: the tags and the dates, not the notebook.
   *
   * The two were one predicate until the notebook moved into the drawer, and keeping them
   * one lit the filter badge for a notebook the filter sheet no longer chooses — a dot
   * saying "something is narrowing this" beside a heading that had already said what, and
   * pointing at a surface where nothing was set. A badge has to be about the control it
   * sits on.
   *
   * `isFiltered` is still the whole scope, and still what the export link and the desktop
   * stack read: those are about the slice of the archive on screen, which the notebook is
   * very much part of.
   */
  const sheetFiltered = Boolean(selectedTags.length || from || to);

  const list = useInfiniteQuery(notesQuery(filter, ordering));
  const tags = useQuery(tagsQuery());
  const notebooks = useQuery(notebooksQuery());
  const trashCount = useQuery(trashCountQuery());
  const trashed = trashCount.data ?? 0;

  /**
   * The search term, debounced.
   *
   * The URL updates on every keystroke so the field stays a controlled input and the
   * query is shareable, but the request waits until typing settles.
   */
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), 180);
    return () => clearTimeout(timer);
  }, [q]);
  const search = useQuery(searchQuery(debounced, filter));

  /*
   * The phone's header is a different set of controls, not the same ones restyled, so this
   * is one of the few places the app reads the breakpoint in JS rather than in CSS. The
   * policy in `useMediaQuery` allows exactly this — a control whose *meaning* changes with
   * width — and what it protects against is elsewhere: the editor is an uncontrolled
   * CodeMirror view that must not be rebuilt, and nothing here is in its tree.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /*
   * Which page the sheet is showing. One dialog that swaps its contents rather than a
   * second sheet over the first, which would dim the first behind the second and leave two
   * scrims on screen — Android's `FilterSheet` records the same choice.
   */
  const [sheetPage, setSheetPage] = useState<'root' | 'tags' | 'dates'>('root');

  /*
   * Closing always returns to the root. A sheet reopening on the page it was last closed
   * from would open on tags for someone who went there once, and the root is what says
   * what is filtered.
   */
  const closeSheet = () => {
    setSheetOpen(false);
    setSheetPage('root');
  };
  /*
   * Search starts open when the URL arrives with a query, so a shared link shows the field
   * it was searched in rather than a bare list with results in it.
   */
  const [searchOpen, setSearchOpen] = useState(q !== '');

  /*
   * The sheet cannot outlive the width that justifies it. Rotating a phone to landscape
   * crosses the breakpoint, and a modal dialog left open over the desktop layout would sit
   * on top of the very controls it contains, now visible in the sidebar behind it.
   */
  useEffect(() => {
    if (!isMobile) {
      setSheetOpen(false);
      setSheetPage('root');
      setDrawerOpen(false);
    }
  }, [isMobile]);

  /** Writes the search box's value to the URL. Shared by both breakpoints' fields. */
  const setQuery = (next: string) =>
    void navigate({
      to: '/notes',
      // replace, not push: the query updates per keystroke, and pushing would make
      // Back crawl out of a search one character at a time.
      search: (prev) => ({ ...prev, q: next || undefined }),
      replace: true,
    });

  /** Null means "not searching", which is distinct from searching and finding nothing. */
  const results = debounced.trim() === '' ? null : (search.data ?? null);

  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? null;
  const error = list.error ?? search.error;

  /*
   * Whether the rows on screen are the rows for the heading above them.
   *
   * The route commits before the list arrives — see the loader in `routes/notes.tsx` —
   * so for a moment the heading names the new notebook while the rows are still the
   * previous one's, kept by `keepPreviousData`. Nothing on screen may claim otherwise
   * during that moment: the count says loading rather than the old total, and the list
   * marks itself busy so it can be dimmed. `isPending` is the first load, where there are
   * no previous rows to keep and the empty state must not flash "No notes yet".
   */
  const stale = list.isPlaceholderData;
  const loading = list.isPending || stale;

  /** Search results are on screen, which changes what is worth offering beside them. */
  const searching = results !== null;

  /**
   * Where the list is, for the phone's heading.
   *
   * The notebook names itself; "Inbox" is what the UNFILED sentinel is called everywhere
   * the user can see it; "All notes" is the unnarrowed list, and it matches the drawer's
   * own first row so the heading and the place you picked it from agree.
   *
   * Tags are deliberately not in it. They are already under the header as chips that can be
   * taken off, and a heading listing them would either duplicate that or truncate it.
   */
  const scopeLabel =
    notebook === UNFILED ? 'Inbox' : (notebook ?? 'All notes');

  /** What the list is showing, in three forms. Both breakpoints' headers read it. */
  const countLabel =
    results !== null
      ? `${results.length} matches`
      : loading
        ? 'Loading…'
        : total !== null && total > notes.length
          ? `${notes.length} of ${total} notes`
          : `${notes.length} notes`;

  async function newNote() {
    try {
      // Carry the active filter onto the new note, otherwise it is created and then
      // immediately filtered out of the list the user is looking at.
      const created = await api.createNote({
        // No name, rather than the literal string "Untitled". The title field's
        // placeholder already says that word, and a placeholder is not data: a stored
        // "Untitled" is written into the frontmatter of the exported markdown, sorted
        // under U by the title sort, and — titles being in the FTS index — returned by a
        // search for "untitled", all to say the note has no name yet. Android has always
        // created notes with an empty title; this is the web agreeing with it.
        title: '',
        body: '',
        // Every active tag, not just one: with two tags filtered, a note carrying only
        // the first is still filtered out of the list it was created in.
        tags: tag ?? [],
        // UNFILED is a filter sentinel, not a notebook name — a note created while
        // viewing it belongs in no notebook.
        notebook: notebook === UNFILED ? null : (notebook ?? null),
      });
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      invalidateNoteMembership(queryClient);
      // A new note starts with its name, so the title takes the caret rather than the
      // body. Recorded here, before navigating, because it is a fact about this note's
      // creation and the workspace it opens has no other way to know it.
      markNewNote(created.id);
      void navigate({ to: '/notes/$noteId', params: { noteId: created.id }, search: (p) => p });
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className={layout.className} style={layout.style} ref={layout.containerRef}>
      <aside className="sidebar">
        {isMobile ? (
          <>
            <NoteListHead
              count={countLabel}
              title={scopeLabel}
              query={q}
              onQuery={setQuery}
              searchOpen={searchOpen}
              onOpenSearch={() => setSearchOpen(true)}
              /*
               * Closing clears the query. A closed field over a live `q` is a list narrowed
               * by something with nothing on screen to say so — the same invisible-filter
               * failure the chips below exist to prevent.
               */
              onCloseSearch={() => {
                setSearchOpen(false);
                setQuery('');
              }}
              onOpenFilters={() => setSheetOpen(true)}
              onOpenMenu={() => setDrawerOpen(true)}
              filtered={sheetFiltered}
              /* Hidden while searching — results come back ranked by relevance, and
                 reordering them by date would throw away that ranking. Nothing else is
                 lost with it: Settings, which used to share this corner, is on the
                 drawer's floor. */
              sort={results === null ? <NotesSort sort={sort} order={order} /> : null}
            />

            {error && <p className="bad small">{(error as Error).message}</p>}

            {/*
                Under the header rather than only inside the sheet, so what is narrowing the
                list is readable without opening anything — and removable without it too.

                No notebook chip here: the heading above already names it, and the chip
                repeated that word for word on the next line, spending a row of a phone
                screen to say it twice. The sheet still shows it, because a surface that
                claims to list everything applied has to.
            */}
            <ActiveFilters tags={selectedTags} from={from} to={to} />

            <NotebookDrawer
              open={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              notebook={notebook}
              selectedTags={selectedTags}
              notebooks={notebooks}
              trashed={trashed}
              email={session?.user.email ?? ''}
              onSignOut={signOutAndLeave}
            />

            <Sheet
              open={sheetOpen}
              onClose={closeSheet}
              title={
                sheetPage === 'tags' ? 'Tags' : sheetPage === 'dates' ? 'Dates' : 'Filter notes'
              }
              onBack={sheetPage === 'root' ? undefined : () => setSheetPage('root')}
              headAction={
                // Offered only when it would do something: a permanently visible Clear all
                // on an unfiltered list promises an effect it cannot have. Not on the tags
                // page, where the chips are the way back out and "all" would mean the
                // dates too — a button whose blast radius is off screen.
                sheetPage === 'root' && sheetFiltered ? (
                  <Button
                    variant="quiet"
                    size="small"
                    onClick={() =>
                      void navigate({
                        to: '/notes',
                        // The notebook is not cleared: it is where you are, not something
                        // this sheet applied, and "Clear all" walking you out of a notebook
                        // into the whole archive is a bigger effect than the words promise.
                        search: (prev) => ({
                          ...prev,
                          tag: undefined,
                          from: undefined,
                          to: undefined,
                        }),
                      })
                    }
                  >
                    Clear all
                  </Button>
                ) : null
              }
            >
              {sheetPage === 'tags' && (
                <TagPicker tags={tags.data ?? []} selected={selectedTags} />
              )}

              {sheetPage === 'dates' && (
                <DatePicker from={from} to={to} onDone={() => setSheetPage('root')} />
              )}

              {sheetPage === 'root' && (
                <>
                  {/*
                      What this sheet has applied, and how each of it comes off.

                      The notebook is deliberately absent, unlike Android's version of this
                      surface. There it is the one filter the sheet reports but does not
                      set, because its drawer is the only place naming it; here the list
                      header names it permanently, one line above, so a chip for it was the
                      third place saying "Coupons" on one screen.
                  */}
                  {sheetFiltered ? (
                    <ActiveFilters tags={selectedTags} from={from} to={to} />
                  ) : (
                    <p className="sheet-summary small">Nothing is filtered.</p>
                  )}

                  <hr className="sheet-rule" />

                  {/*
                      Two rows, each opening a page of its own — the shape Android's sheet
                      settled on, and for the reason its root page stays readable: the tag
                      picker is a find field and an unbounded list, and the dates are five
                      pills plus two labelled fields. Inlined, either one is taller than
                      everything else here put together.

                      Neither the notebook nor the sort is among them. The notebook is a
                      place you go, so it is in the drawer; sort changes the order rather
                      than the membership, so it is under the ⋯ with Settings.
                  */}
                  {!searching && (tags.data?.length ?? 0) > 0 && (
                    <FilterRow
                      icon={<TagIcon />}
                      label="Tags"
                      value={
                        selectedTags.length > 0
                          ? `${selectedTags.length} ${selectedTags.length === 1 ? 'tag' : 'tags'}`
                          : undefined
                      }
                      onClick={() => setSheetPage('tags')}
                    />
                  )}

                  <FilterRow
                    icon={<CalendarIcon />}
                    label="Dates"
                    value={rangeLabel(from, to) ?? undefined}
                    onClick={() => setSheetPage('dates')}
                  />

                  {!searching && isFiltered && (
                    <ExportLink filter={filter} sort={sort} total={total} />
                  )}
                </>
              )}

              {/*
                  Done only on the root.

                  A sub-page had one too, which offered two ways out that did different
                  things — back to the filters, or out of the sheet entirely — from two
                  controls a thumb's width apart. The phone app has the same pages and puts
                  the way out only where the sheet itself ends; the arrow is how a page ends.
              */}
              {sheetPage === 'root' && (
                <div className="sheet-foot">
                  <Button variant="quiet" onClick={closeSheet}>
                    Done
                  </Button>
                </div>
              )}
            </Sheet>
          </>
        ) : (
          <>
            <div className="sidebar-head">
              <span className="count">{countLabel}</span>
              <Button variant="primary" onClick={() => void newNote()}>
                New
              </Button>
            </div>

            {error && <p className="bad small">{(error as Error).message}</p>}

            <input
              className="search-field"
              type="search"
              value={q}
              placeholder="Search notes…"
              onChange={(e) => setQuery(e.target.value)}
            />

            {!searching && (
              <NotebookSelect
                notebook={notebook}
                notebooks={notebooks}
                endsFilters={(tags.data?.length ?? 0) === 0}
              />
            )}

            {/* Hidden while searching: results come back ranked by relevance, and
                reordering them by date would throw away that ranking. */}
            {!searching && <SortSelect sort={sort} order={order} />}

            <DateRange from={from} to={to} />

            {!searching && isFiltered && (
              <ExportLink filter={filter} sort={sort} total={total} />
            )}

            {!searching && <TagFilter tags={tags.data ?? []} selected={selectedTags} />}
          </>
        )}

        {/*
          * New, as a button floating over the list.
          *
          * Where every notes app people arrive from puts it, and what frees the header row
          * for the four controls that are about what is on screen. Inside `.sidebar` rather
          * than the shell so the rule that hides the list when a note is open takes this
          * with it — a "new note" button floating over the note you are reading would make
          * one every time a thumb reached for the scroll bar.
          */}
        {isMobile && (
          <button type="button" className="fab" aria-label="New note" onClick={() => void newNote()}>
            <PlusIcon />
          </button>
        )}

        <ul className="note-list" aria-busy={stale || undefined} onKeyDown={onListKeys}>
          {results !== null && <SearchResults results={results} />}

          {results === null &&
            notes.map((n) => (
              <NoteListItem
                key={n.id}
                note={n}
                to="/notes/$noteId"
                sort={sort ?? 'updated'}
                transition={isMobile}
              />
            ))}

          {results === null && list.hasNextPage && (
            <li>
              <button
                type="button"
                className="load-more"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </li>
          )}

          {results === null && notes.length === 0 && !error && !list.isPending && (
            <li className="muted small empty">
              {tag
                ? `No notes tagged ${tag}.`
                : notebook === UNFILED
                  ? 'Nothing in your inbox.'
                  : notebook
                    ? `No notes in ${notebook}.`
                    : 'No notes yet.'}
            </li>
          )}
        </ul>

        {/*
          * Trash, pinned under the note list.
          *
          * It sits below the list rather than up in the filter stack because it is a
          * destination, not a filter — but it belongs in this column all the same, since
          * what it holds is notes. Every notes app people arrive here from puts deleted
          * notes in the sidebar, and the topbar — now account chrome only — is the one
          * place nobody would think to look for them.
          *
          * `.note-list` takes the leftover height, so this lands on the sidebar floor
          * without anything here having to position it. The rule above it is what stops
          * it reading as one more filter; the count is what stays conditional. No
          * `activeProps`: /trash renders TrashLayout's own sidebar in place of this one,
          * so this link is never on screen while it is the active route.
          */}
        <Link to="/trash" className="trash-link">
          Trash
          {trashed > 0 && <span className="tag-count">{trashed}</span>}
        </Link>
        <IndexingStatus />
      </aside>

      <ResizeHandle
        label="Resize sidebar"
        containerRef={layout.containerRef}
        /**
         * Measured from the grid's left edge, less the channel between the two columns.
         *
         * The handle does not sit at the sidebar's right edge — the grid puts a gap either
         * side of the handle track, so the divider renders at `width + gap`. Treating the
         * pointer position as the width directly therefore set a width that pushed the
         * handle further right than the cursor, and it trailed the pointer by the gap for
         * the whole drag.
         */
        toValue={(clientX, rect, gap) => clientX - rect.left - gap}
        value={layout.width}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        step={16}
        defaultValue={SIDEBAR_DEFAULT}
        onResize={layout.onResize}
        onCommit={layout.onResizeCommit}
      />

      {children}
    </div>
  );
}
