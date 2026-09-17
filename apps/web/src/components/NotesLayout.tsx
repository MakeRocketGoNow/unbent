import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { UNFILED, type FieldDef, type FieldValue } from '@unbent/shared';
import * as api from '../notes-api.js';
import { Route } from '../routes/notes.js';
import {
  notesQuery,
  tagsQuery,
  notebooksQuery,
  notebookFieldsQuery,
  searchQuery,
  trashCountQuery,
  invalidateNoteMembership,
} from '../queries.js';
import { useNotesLayout } from '../useNotesLayout.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem } from './NoteListItem.js';
import { useListKeys, enterList } from '../useListKeys.js';
import { useFocusSearch } from '../useFocusSearch.js';
import { markNewNote } from '../useNewNote.js';
import { SearchResults } from './SearchResults.js';
import { IndexingStatus } from './IndexingStatus.js';
import { Button } from './Button';
import { NotebookSelect } from './NotebookSelect.js';
import { ExportLink } from './ExportLink.js';
import { TagPicker } from './TagPicker.js';
import { FilterRow } from './FilterRow.js';
import { DatePicker } from './DatePicker.js';
import { FieldsPicker } from './FieldsPicker.js';
import { rangeLabel } from './format-when.js';
import { NotebookDrawer } from './NotebookDrawer.js';
import { PlusIcon, TagIcon, CalendarIcon, FieldsIcon } from './icons.js';
import { Sheet } from './Sheet.js';
import { NoteListHead } from './NoteListHead.js';
import { NotesSort } from './NotesSort.js';
import { NotesViewToggle } from './NotesViewToggle.js';
import { NoteTable } from './NoteTable.js';
import { noteColumns } from './note-columns.js';
import { nextColumnSort, type SortTarget } from './sort-options.js';
import { patchNoteFields, patchNotePages } from './note-table-edit.js';
import { loadMoreLabel } from './load-more.js';
import { useNotesView } from '../useNotesView.js';
import { editOpenNoteField } from '../open-note-fields.js';
import { keys } from '../queries.js';
import { ActiveFilters } from './ActiveFilters.js';
import { ScopeMatches, scopeMatches } from './ScopeMatches.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { useSession } from '../auth-client.js';
import { useSignOut } from '../useSignOut.js';

/** Sidebar plus the routed workspace. Filters come from the URL; nothing here is mirrored into state. */
export function NotesLayout({ children }: { children: React.ReactNode }) {
  const { notebook, tag, field, q = '', sort, order, sortField, from, to } = Route.useSearch();
  /** The tag filter as a list, so the sidebar never has to care that it may be absent. */
  const selectedTags = tag ?? [];
  /** Likewise the field filters, as the wire strings the URL carries. */
  const fieldFilters = field ?? [];
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  /*
   * The search field and the list, so the arrow keys can pass between them: Down in the
   * field enters the list on its first row, Up on that row returns to the field. The
   * list is one of two elements, the sidebar's `<ul>` or the table; only one exists.
   */
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const onListKeys = useListKeys({ onLeaveTop: () => searchRef.current?.focus() });
  // Cmd/Ctrl+F focuses search from anywhere in the view; a second press falls through to
  // the browser's find. See the hook.
  useFocusSearch(searchRef);
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
    ...(field ? { field } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const ordering = {
    ...(sort ? { sort } : {}),
    ...(order ? { order } : {}),
    ...(sortField ? { sortField } : {}),
  };

  /**
   * Whether anything narrows the list, notebook included. The export link reads this: it
   * is the current filter serialized, and because the filters already live in the URL
   * there is no separate state to keep in step — the link is the view.
   */
  const isFiltered = Boolean(notebook || selectedTags.length || fieldFilters.length || from || to);

  /*
   * What the filter icon speaks for: the tags and the dates, not the notebook.
   *
   * The two were one predicate until the notebook moved into the drawer, and keeping them
   * one lit the filter badge for a notebook the filter sheet no longer chooses — a dot
   * saying "something is narrowing this" beside a heading that had already said what, and
   * pointing at a surface where nothing was set. A badge has to be about the control it
   * sits on.
   *
   * `isFiltered` is still the whole scope, and still what the export link reads: that is
   * about the slice of the archive on screen, which the notebook is very much part of.
   */
  const sheetFiltered = Boolean(selectedTags.length || fieldFilters.length || from || to);

  const list = useInfiniteQuery(notesQuery(filter, ordering));
  const tags = useQuery(tagsQuery());
  const notebooks = useQuery(notebooksQuery());
  /*
   * The selected notebook's field definitions, which name the field chips and are what
   * the sheet's Fields page offers. Field definitions belong to a notebook, so with no
   * notebook selected there is nothing to ask for and the query stays disabled; the id
   * is looked up from the name, because the URL carries the name.
   */
  const notebookId =
    notebook && notebook !== UNFILED
      ? notebooks.data?.notebooks.find((nb) => nb.name === notebook)?.id
      : undefined;
  const fieldDefs = useQuery(notebookFieldsQuery(notebookId));
  /** The definition behind a sort by a field, once the notebook's fields have loaded. */
  const sortFieldDef = sortField ? fieldDefs.data?.find((d) => d.id === sortField) : undefined;
  /*
   * A sort by a field the notebook does not have — or by any field outside a notebook —
   * is a stale or hand-edited link. Dropped once that is known rather than sent, since the
   * API refuses the whole list for it and a link should still open. Replaced, not pushed:
   * Back should not return to the broken order.
   */
  const sortFieldStale =
    sortField !== undefined &&
    ((notebooks.isSuccess && notebookId === undefined) ||
      (fieldDefs.isSuccess && sortFieldDef === undefined));
  useEffect(() => {
    if (!sortFieldStale) return;
    void navigate({
      to: '/notes',
      search: (prev) => ({ ...prev, sortField: undefined }),
      replace: true,
    });
  }, [sortFieldStale, navigate]);
  const trashCount = useQuery(trashCountQuery());
  const trashed = trashCount.data ?? 0;

  /**
   * The search term, debounced.
   *
   * The URL updates on every keystroke so the field stays a controlled input and the
   * query is shareable, but the request waits until typing settles. 300ms: the archive
   * is thousands of notes over a network, so a request fired mid-word is usually thrown
   * away before it lands, and the wait is short enough that a settled query still feels
   * immediate.
   */
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const search = useQuery(searchQuery(debounced, filter));

  /*
   * One sidebar at every width, with the breakpoint deciding a handful of props rather
   * than which tree to render.
   *
   * It was two trees: the phone's header, chips and sheet, and a desktop stack of
   * permanently open controls — a search field, two selects, five date pills, a pair of
   * date inputs, an export link and a tag disclosure — that on a 19rem column left the
   * note list a few rows tall, on the screen whose entire job is listing notes. The
   * phone's shape is the one every notes app has settled on, so the desktop takes it
   * too, and what is left of the difference is: the search field is a permanent row
   * rather than behind an icon, New is a button in the head rather than floating, the
   * notebook is picked from a select rather than a drawer, and the sheet is a panel
   * beside the list rather than one from the floor (CSS decides that last one).
   *
   * This is one of the few places the app reads the breakpoint in JS rather than in
   * CSS. The policy in `useMediaQuery` allows exactly this — a control whose *meaning*
   * changes with width — and what it protects against is elsewhere: the editor is an
   * uncontrolled CodeMirror view that must not be rebuilt, and nothing here is in its
   * tree.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /*
   * Which page the sheet is showing. One dialog that swaps its contents rather than a
   * second sheet over the first, which would dim the first behind the second and leave two
   * scrims on screen — Android's `FilterSheet` records the same choice.
   */
  const [sheetPage, setSheetPage] = useState<'root' | 'tags' | 'dates' | 'fields'>('root');

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
   * The drawer cannot outlive the width that justifies it. Rotating a phone to landscape
   * crosses the breakpoint, and above it there is no ☰ to have opened the drawer from
   * and a notebook select in the sidebar doing its job — a phone's drawer left open over
   * the desktop grid is a panel nothing on screen explains. The filter sheet is not
   * closed with it any more: it has a desktop shape of its own, and the controls it holds
   * are no longer duplicated in the sidebar behind it.
   */
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
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
  /** Whether the results will be headed by picks, which is when the notes need a caption too. */
  const picks = scopeMatches(debounced, tags.data ?? [], notebooks.data, selectedTags, notebook);
  const hasPicks = picks.tags.length > 0 || picks.notebooks.length > 0;

  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? null;

  /*
   * A field edited from a table cell.
   *
   * The row changes at once and the save follows, the way the note's own property list
   * behaves; a failure puts the row back and says so on the error line. The rest of the
   * list is refetched afterwards rather than patched, because the edit bumps the note's
   * updated date — under the default sort the row then moves to the top, which is what
   * any edit does to the list today and not something a table should quietly hide.
   *
   * The open note is the exception: its editor holds a draft that would write the old
   * value back over a direct save, so its edits go to that draft (`editOpenNoteField`)
   * and the editor saves them. The row is still patched here so the two agree at once.
   */
  const listKey = keys.notes(filter, ordering);
  const patchRow = (noteId: string, def: FieldDef, value: FieldValue | null) =>
    queryClient.setQueryData(listKey, (data: Parameters<typeof patchNotePages>[0]) =>
      patchNotePages(data, noteId, (n) => patchNoteFields(n, def, notebook ?? '', value)),
    );
  const editField = useMutation({
    mutationFn: ({ noteId, def, value }: { noteId: string; def: FieldDef; value: FieldValue | null }) =>
      api.updateNote(noteId, { fields: { [def.id]: value } }),
    onMutate: async ({ noteId, def, value }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData(listKey);
      patchRow(noteId, def, value);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
    },
    onSuccess: (updated) => {
      // Only a note already in the cache: reopening it should show what the table saved.
      if (queryClient.getQueryData(keys.note(updated.id))) {
        queryClient.setQueryData(keys.note(updated.id), updated);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });
  const onEditCell = (noteId: string, def: FieldDef, value: FieldValue | null) => {
    if (editOpenNoteField(noteId, def.id, value)) {
      patchRow(noteId, def, value);
      return;
    }
    editField.mutate({ noteId, def, value });
  };

  const error = list.error ?? search.error ?? editField.error;

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

  /*
   * The list as a table of the notebook's fields — the notebook's own choice, remembered
   * by `useNotesView`, and honoured only where a table makes sense: inside one notebook
   * (columns are its fields), at desktop width (a phone has no room for columns), and
   * not over search results (which are ranked, not columned). Everywhere else the list is
   * drawn, and the toggle shows that.
   */
  const [view, setView] = useNotesView(notebookId);
  const tableMode = view === 'table' && !isMobile && !searching && notebookId !== undefined;
  const layout = useNotesLayout('/notes/$noteId', { mode: tableMode ? 'table' : 'list' });
  const columns = noteColumns(fieldDefs.data ?? []);
  /** A column header was clicked: write the order it asks for. */
  const sortBy = (target: SortTarget) =>
    void navigate({
      to: '/notes',
      search: (prev) => ({ ...prev, ...nextColumnSort(target, prev) }),
    });
  /** The list's empty state, in words; both renderings say the same thing. */
  const emptyMessage =
    notes.length === 0 && !error && !list.isPending
      ? tag
        ? `No notes tagged ${tag}.`
        : fieldFilters.length > 0
          ? 'No notes match those fields.'
          : notebook === UNFILED
            ? 'Nothing in your inbox.'
            : notebook
              ? `No notes in ${notebook}.`
              : 'No notes yet.'
      : null;

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

  /**
   * What the list is showing, in three forms. Both breakpoints' headers read it.
   *
   * The total, not "50 of 900 notes": how many are loaded so far is a paging detail and
   * the Load more button says it — see `loadMoreLabel`. The header shares its row with
   * four controls, and the longer string was the one thing in it that truncated.
   */
  const countLabel =
    results !== null
      ? `${results.length} matches`
      : loading
        ? 'Loading…'
        : `${total ?? notes.length} notes`;

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
        <NoteListHead
          count={countLabel}
          /* Where the list is, on a phone. At desktop width the notebook select one row
             down says it, and a heading over a select saying the same word is the "third
             place saying Coupons" the chip strip's comment describes. */
          title={isMobile ? scopeLabel : undefined}
          query={q}
          onQuery={setQuery}
          onArrowDown={() => enterList(listRef.current ?? tableRef.current)}
          fieldRef={searchRef}
          searchOpen={searchOpen}
          /* Behind an icon on a phone; a permanent row on a desktop. Passing the opener or
             not is how the header is told which — see `NoteListHead`. */
          onOpenSearch={isMobile ? () => setSearchOpen(true) : undefined}
          /*
           * Closing clears the query. A closed field over a live `q` is a list narrowed
           * by something with nothing on screen to say so — the same invisible-filter
           * failure the chips below exist to prevent. On a desktop the field never closes,
           * and this is what Escape in it does.
           */
          onCloseSearch={() => {
            setSearchOpen(false);
            setQuery('');
          }}
          onOpenFilters={() => setSheetOpen(true)}
          onOpenMenu={isMobile ? () => setDrawerOpen(true) : undefined}
          filtered={sheetFiltered}
          /* Hidden while searching — results come back ranked by relevance, and
             reordering them by date would throw away that ranking. Nothing else is
             lost with it: Settings, which used to share this corner, is on the
             drawer's floor. */
          sort={
            results === null ? (
              <NotesSort
                sort={sort}
                order={order}
                sortField={sortField}
                fieldName={sortFieldDef?.name}
              />
            ) : null
          }
          /* Hidden where the table is never drawn — a phone, a search — and disabled with
             the reason outside a notebook, where there are no fields to column. */
          view={
            !isMobile && !searching ? (
              <NotesViewToggle
                value={tableMode ? 'table' : 'list'}
                onChange={setView}
                tableDisabledReason={
                  notebookId === undefined
                    ? 'choose a notebook to see its fields as columns'
                    : undefined
                }
              />
            ) : undefined
          }
          /* New is a floating button on a phone (below) and the end of this row on a
             desktop, where a column has nothing for a button to float clear of. */
          action={
            isMobile ? undefined : (
              <Button variant="primary" onClick={() => void newNote()}>
                New
              </Button>
            )
          }
        />

        {error && <p className="bad small">{(error as Error).message}</p>}

        {/*
            The notebook, as a select, at desktop width only.

            It is navigation rather than a filter — a place you go — which is why the phone
            keeps it in the drawer and the sheet does not offer it. The desktop has no
            drawer; a rail for it is a separate decision, and until then the select is the
            one control that stays in the column. Hidden while searching, like the sort:
            search is scoped to the notebook, but a select above relevance-ranked results
            invites being read as something that reorders them.
        */}
        {!isMobile && !searching && <NotebookSelect notebook={notebook} notebooks={notebooks} />}

        {/*
            Under the header rather than only inside the sheet, so what is narrowing the
            list is readable without opening anything — and removable without it too.

            No notebook chip here: the heading above (or the select, on a desktop) already
            names it, and the chip repeated that word for word on the next line, spending
            a row of a phone screen to say it twice. The sheet still shows it, because a
            surface that claims to list everything applied has to.
        */}
        <ActiveFilters
          tags={selectedTags}
          fields={fieldFilters}
          fieldDefs={fieldDefs.data ?? []}
          from={from}
          to={to}
        />

        {isMobile && (
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
        )}

        <Sheet
          open={sheetOpen}
          onClose={closeSheet}
          title={
            sheetPage === 'tags'
              ? 'Tags'
              : sheetPage === 'dates'
                ? 'Dates'
                : sheetPage === 'fields'
                  ? 'Fields'
                  : 'Filter notes'
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
                      field: undefined,
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
          {sheetPage === 'tags' && <TagPicker tags={tags.data ?? []} selected={selectedTags} />}

          {sheetPage === 'dates' && (
            <DatePicker from={from} to={to} onDone={() => setSheetPage('root')} />
          )}

          {sheetPage === 'fields' && (
            <FieldsPicker defs={fieldDefs.data ?? []} selected={fieldFilters} />
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
                <ActiveFilters
                  tags={selectedTags}
                  fields={fieldFilters}
                  fieldDefs={fieldDefs.data ?? []}
                  from={from}
                  to={to}
                />
              ) : (
                <p className="sheet-summary small">Nothing is filtered.</p>
              )}

              <hr className="sheet-rule" />

              {/*
                  A row per filter, each opening a page of its own — the shape Android's
                  sheet settled on, and for the reason its root page stays readable: the
                  tag picker is a find field and an unbounded list, the dates are five
                  rows plus two labelled fields, and the fields page is a control per
                  definition. Inlined, any one is taller than everything else here put
                  together.

                  Neither the notebook nor the sort is among them. The notebook is a
                  place you go, so it is in the drawer or the select; sort changes the
                  order rather than the membership, so it is under its own icon.
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

              {/*
                  Fields, between tags and dates, and only inside a notebook that has any.
                  Field definitions belong to a notebook, so outside one there is nothing
                  to offer, and a row that opened onto an empty page would be a control
                  that does nothing. The value counts filters rather than naming them:
                  the chips above already name them, and a row has one line.
              */}
              {!searching && (fieldDefs.data?.length ?? 0) > 0 && (
                <FilterRow
                  icon={<FieldsIcon />}
                  label="Fields"
                  value={
                    fieldFilters.length > 0
                      ? `${fieldFilters.length} ${fieldFilters.length === 1 ? 'filter' : 'filters'}`
                      : undefined
                  }
                  onClick={() => setSheetPage('fields')}
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
              (Hidden at desktop width, where the panel's ✕ and Escape are the ways out.)
          */}
          {sheetPage === 'root' && (
            <div className="sheet-foot">
              <Button variant="quiet" onClick={closeSheet}>
                Done
              </Button>
            </div>
          )}
        </Sheet>

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

        {tableMode ? (
          <NoteTable
            notes={notes}
            columns={columns}
            search={{ sort, order, sortField }}
            notebook={notebook ?? ''}
            total={total}
            busy={stale}
            hasNextPage={list.hasNextPage}
            isFetchingNextPage={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            onSort={sortBy}
            onKeyDown={onListKeys}
            tableRef={tableRef}
            empty={emptyMessage}
            onEdit={onEditCell}
          />
        ) : (
        <ul className="note-list" ref={listRef} aria-busy={stale || undefined} onKeyDown={onListKeys}>
          {/*
              Tags and notebooks whose names match, before the notes that do. The needle is
              the debounced query so they arrive together with the results rather than a
              beat ahead of them. Picking one clears the query, and on a phone closes the
              field — the same close the back arrow does, minus the clearing it has already
              done.
          */}
          {results !== null && (
            <ScopeMatches
              query={debounced}
              tags={tags.data ?? []}
              notebooks={notebooks.data}
              selectedTags={selectedTags}
              notebook={notebook}
              onPick={() => setSearchOpen(false)}
            />
          )}
          {results !== null && hasPicks && <li className="list-caption">Notes</li>}
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
                {loadMoreLabel(notes.length, total, list.isFetchingNextPage)}
              </button>
            </li>
          )}

          {results === null && emptyMessage && (
            <li className="muted small empty">{emptyMessage}</li>
          )}
        </ul>
        )}

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
        min={layout.min}
        max={layout.max}
        step={16}
        defaultValue={layout.defaultValue}
        onResize={layout.onResize}
        onCommit={layout.onResizeCommit}
      />

      {children}
    </div>
  );
}
