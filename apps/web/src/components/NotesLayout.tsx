import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useQuery, useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  DEFAULT_NOTE_SORT,
  UNFILED,
  narrowsList,
  sameViewQuery,
  viewQueryOf,
  type FieldDef,
  type FieldValue,
  type NotebookView,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import * as actions from '../store/actions.js';
import { isOfflineError } from '../notes-api.js';
import {
  notesQuery,
  fieldTotalsQuery,
  tagsQuery,
  notebooksQuery,
  notebookFieldsQuery,
  searchQuery,
  trashCountQuery,
  invalidateNoteMembership,
  configQuery,
  viewsQuery,
} from '../queries.js';
import { useNotesLayout, type NotesViewMode } from '../useNotesLayout.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem, type RowSelection } from './NoteListItem.js';
import { NoteCard } from './NoteCard.js';
import { useListKeys, enterList } from '../useListKeys.js';
import { useFocusSearch } from '../useFocusSearch.js';
import { useCreateNote, useHoldWhileCreating } from '../useCreateNote.js';
import { useNewNoteRequest } from '../useNewNoteRequest.js';
import { SearchResults } from './SearchResults.js';
import { IndexingStatus } from './IndexingStatus.js';
import { SampleNotes } from './SampleNotes.js';
import { EmptyLibrary } from './EmptyLibrary.js';
import { Button } from './Button';
import { NotebookMissing, isNotebookMissing } from './NotebookMissing.js';
import { countMenuItems, offersCountMenu } from './count-menu.js';
import { startExport, useExportRunning } from '../export-archive.js';
import { useOffline } from '../connectivity.js';
import { usePlan, READ_ONLY_TIP } from '../use-plan.js';
import { FreeNotesNotice } from './FreeNotesNotice.js';
import { TagPicker } from './TagPicker.js';
import { FilterRow } from './FilterRow.js';
import { DatePicker } from './DatePicker.js';
import { FieldsPicker } from './FieldsPicker.js';
import { rangeLabel } from './format-when.js';
import { NotebookDrawer } from './NotebookDrawer.js';
import {
  PlusIcon,
  TagIcon,
  CalendarIcon,
  FieldsIcon,
  TrashIcon,
  NotebookActionIcon,
  DownloadIcon,
  TagActionIcon,
} from './icons.js';
import { Sheet } from './Sheet.js';
import { NoteListHead } from './NoteListHead.js';
import { NotesSort } from './NotesSort.js';
import { NotesViewMenu } from './NotesViewMenu.js';
import { NoteTable } from './NoteTable.js';
import { noteColumns, totalable } from './note-columns.js';
import { tableTotalsFor } from './table-totals.js';
import { nextColumnSort, type SortTarget } from './sort-options.js';
import { forgetSortField, hasRememberedSort, rememberSort, rememberedSort } from '../notebook-sort.js';
import { patchNoteFields, patchNotePages } from './note-table-edit.js';
import { applySaveToLists } from '../list-cache.js';
import { loadMoreLabel } from './load-more.js';
import { useAutoLoad } from './useAutoLoad.js';
import { scopeLabel, tagPlace } from './scope-label.js';
import { useNotesView } from '../useNotesView.js';
import { editOpenNoteField } from '../open-note-fields.js';
import { keys, type SearchAnswer } from '../queries.js';
import { SearchCoverage } from './SearchCoverage.js';
import { ActiveFilters } from './ActiveFilters.js';
import { ViewActions, VIEW_NEEDS_CONNECTION } from './ViewActions.js';
import { ViewNameField } from './ViewName.js';
import { OverflowMenu } from './OverflowMenu.js';
import { viewSearch } from '../view-address.js';
import { ScopeMatches, scopeMatches } from './ScopeMatches.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { useSelection } from '../useSelection.js';
import { SelectionBar } from './SelectionBar.js';
import { listDropZone, dropSentence } from '../list-drop-zone.js';
import { notesFromFiles } from '../file-notes.js';
import { Confirm } from './Confirm.js';
import { DeleteViewConfirm } from './DeleteViewConfirm.js';
import { MoveSheet } from './MoveSheet.js';
import { TagsSheet } from './TagsSheet.js';
import { editOpenNoteFiling } from '../open-note-fields.js';
import { useAppSession } from '../useAppSession.js';
import { useLibraryArriving, useLibraryWhole, useViewsKnown } from '../store/use-feed-state.js';
import { sameNotebookName } from '../store/derive.js';
import { ListRowsContext, showsWholeAccount, useLibraryTotal } from '../useLibraryTotal.js';
import { useSignOut } from '../useSignOut.js';
import { useListMotion } from '../list-motion.js';
import { useTagColors } from './use-tag-colors.js';

/** Sidebar plus the routed workspace. Filters come from the URL; nothing here is mirrored into state. */
export function NotesLayout({ children }: { children: React.ReactNode }) {
  const {
    notebook,
    tag,
    field,
    q = '',
    sort,
    order,
    sortField,
    view: viewParam,
    from,
    to,
    new: asked,
    saved,
  } = useSearch({ from: '/notes' });
  /** The tag filter as a list, so the sidebar never has to care that it may be absent. */
  const selectedTags = tag ?? [];
  /** Likewise the field filters, as the wire strings the URL carries. */
  const fieldFilters = field ?? [];
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  useNewNoteRequest(asked);
  /*
   * The search field and the list, so the arrow keys can pass between them: Down in the
   * field enters the list on its first row, Up on that row returns to the field. The
   * list is one of two elements, the sidebar's `<ul>` or the table; only one exists.
   */
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Rows leave and arrive rather than vanish when the person's own action moves them.
  const listMotionRef = useListMotion(listRef);
  const tableRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const onListKeys = useListKeys({ onLeaveTop: () => searchRef.current?.focus() });
  // Cmd/Ctrl+F focuses search from anywhere in the view; a second press falls through to
  // the browser's find. See the hook.
  useFocusSearch(searchRef);
  /*
   * The account, for the phone drawer's head. The desktop's rail carries it at that width
   * and the topbar is hidden over the phone's list, so this is where it is reached there:
   * the root layout has already established the session by the time this renders.
   */
  const { session } = useAppSession();
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
   * Whether anything narrows the list, notebook included. The count's export reads this:
   * narrowed, it exports the current filter serialized (because the filters already live
   * in the URL there is no separate state to keep in step, the export is of the view)
   * and otherwise it leads to the whole library's export page.
   */
  const isFiltered = Boolean(notebook || selectedTags.length || fieldFilters.length || from || to);

  /*
   * What the filter icon speaks for: the tags and the dates, not the notebook.
   *
   * The two were one predicate until the notebook moved into the drawer, and keeping them
   * one lit the filter badge for a notebook the filter sheet no longer chooses: a dot
   * saying "something is narrowing this" beside a heading that had already said what, and
   * pointing at a surface where nothing was set. A badge has to be about the control it
   * sits on.
   *
   * `isFiltered` is still the whole scope, and still what the count's export reads: that is
   * about the slice of the archive on screen, which the notebook is very much part of.
   */
  const sheetFiltered = Boolean(selectedTags.length || fieldFilters.length || from || to);

  const list = useInfiniteQuery(notesQuery(filter, ordering));
  const tags = useQuery(tagsQuery());
  const tagColor = useTagColors();
  const notebooks = useQuery(notebooksQuery());
  /** Every saved view: the drawer lists them, and the heading names the open one. */
  const views = useQuery(viewsQuery());
  /*
   * The selected notebook's field definitions, which name the field chips and are what
   * the sheet's Fields page offers. Field definitions belong to a notebook, so with no
   * notebook selected there is nothing to ask for and the query stays disabled; the id
   * is looked up from the name, because the URL carries the name, without case, as the
   * list's filter and the server match it (`sameNotebookName`).
   */
  const notebookId =
    notebook && notebook !== UNFILED
      ? notebooks.data?.notebooks.find((nb) => sameNotebookName(nb.name, notebook))?.id
      : undefined;
  /** The notebook list is the whole account's; see `useLibraryWhole`. */
  const libraryWhole = useLibraryWhole();
  const viewsKnown = useViewsKnown();
  /*
   * The saved view the list was opened from (`?saved=`), once it is known to be one of
   * this notebook's. It names the heading and is what an edit is measured against.
   */
  const openView =
    saved !== undefined && notebookId !== undefined
      ? views.data?.find((v) => v.id === saved && v.notebookId === notebookId)
      : undefined;
  /*
   * Ids of views saved from this page, which the list opens at the moment the save
   * returns. `createView` resolves once the library holds the row, but the query that
   * reads it re-runs a beat later, and in that beat the id names no view it knows: this
   * keeps the drop below from taking a view that was made a moment ago for a stale one.
   *
   * Only for that beat: an id leaves the set once the views query has answered with it
   * on its own, after the row this page put in its cache (`holdView`, which is why the
   * time it was held is kept), and the query is the judge from then on like any other
   * id's, so a view deleted later on another device is dropped from the address here too.
   */
  const madeHere = useRef(new Map<string, number>());
  useEffect(() => {
    for (const [id, heldAt] of madeHere.current) {
      if (views.dataUpdatedAt > heldAt && views.data?.some((v) => v.id === id)) madeHere.current.delete(id);
    }
  }, [views.data, views.dataUpdatedAt]);
  /*
   * A `saved` that names no view of this notebook (deleted on another device, an old
   * link, a notebook renamed under it) is dropped once that is known, as a stale field
   * sort is below: the list it opens is the notebook with the filters the link carries,
   * and the heading names the notebook. Replaced, not pushed: Back should not return to
   * an address naming a view that is gone. Not while the views or the notebooks are
   * still arriving, which is not knowing, and not while the device cannot know its views
   * at all (`useViewsKnown`): a copy made before views, until it is filled, answers an
   * empty list that says nothing, and a shared link would lose its view to it.
   */
  const savedStale =
    saved !== undefined &&
    openView === undefined &&
    !madeHere.current.has(saved) &&
    viewsKnown &&
    views.isSuccess &&
    !views.isFetching &&
    notebooks.isSuccess &&
    (notebookId !== undefined || libraryWhole);
  useEffect(() => {
    if (!savedStale) return;
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, saved: undefined }),
      replace: true,
      resetScroll: false,
    });
  }, [savedStale, navigate]);
  const fieldDefs = useQuery(notebookFieldsQuery(notebookId));
  const config = useQuery(configQuery());
  /** The definition behind a sort by a field, once the notebook's fields have loaded. */
  const sortFieldDef = sortField ? fieldDefs.data?.find((d) => d.id === sortField) : undefined;
  /*
   * A sort by a field the notebook does not have (or by any field outside a notebook)
   * is a stale or hand-edited link. Dropped once that is known rather than sent, since the
   * API refuses the whole list for it and a link should still open. Replaced, not pushed:
   * Back should not return to the broken order. A notebook missing from a library still
   * arriving is not known to be missing, and dropping the sort then forgets it for good.
   */
  const sortFieldStale =
    sortField !== undefined &&
    ((libraryWhole && notebooks.isSuccess && notebookId === undefined) ||
      (fieldDefs.isSuccess && sortFieldDef === undefined));
  useEffect(() => {
    if (!sortFieldStale) return;
    // Remembered too, most likely: that is how a deleted field's sort comes back.
    forgetSortField(notebook);
    void navigate({
      to: '/notes',
      search: (prev) => ({ ...prev, sortField: undefined }),
      replace: true,
    });
  }, [sortFieldStale, navigate]);
  /*
   * A place opened by a URL that names no order is given the one it was last left in.
   *
   * The drawer's links already carry it (see `scopeOf` in `NotebookNav`), so this is for
   * everything else that arrives bare: a cold start at `/notes`, a bookmark, the back
   * arrows out of Settings and the trash. Replaced, not pushed: it fills in the entry
   * rather than moving from it.
   *
   * Only on arriving in a place, never while in one. Absent is also how the URL spells
   * the default, so a check on absence alone would put the old order straight back the
   * moment "Newest first" was picked. Picking it has already forgotten the place by
   * then (`rememberSort`), but the arrival rule is what keeps the two from depending on
   * the order the writes land in. Back to a bare entry is an arrival too, and opens in
   * the remembered order rather than the default that entry happened to be made with:
   * remembering is the point, and the list is the same notes either way.
   *
   * Not into a saved view. A view keeps its own order, the default included, and a view
   * saved in "Newest first" would open in the notebook's remembered "A–Z" and read as
   * edited the moment it opened.
   */
  const seededFor = useRef<string | null>(null);
  const scope = notebook ?? '';
  const orderingUnsaid = !sort && !order && !sortField;
  useEffect(() => {
    if (seededFor.current === scope) return;
    seededFor.current = scope;
    if (!orderingUnsaid || saved !== undefined || !hasRememberedSort(notebook)) return;
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, ...rememberedSort(notebook) }),
      replace: true,
      // `.` can be an open note, and filling in the URL is not a new page.
      resetScroll: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);  /** For the phone drawer's floor; the desktop's rail asks for it itself. */
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

  /*
   * One sidebar at every width, with the breakpoint deciding a handful of props rather
   * than which tree to render.
   *
   * It was two trees: the phone's header, chips and sheet, and a desktop stack of
   * permanently open controls (a search field, two selects, five date pills, a pair of
   * date inputs, an export link and a tag disclosure) that on a 19rem column left the
   * note list a few rows tall, on the screen whose entire job is listing notes. The
   * phone's shape is the one every notes app has settled on, so the desktop takes it
   * too, and what is left of the difference is: the search field is a permanent row
   * rather than behind an icon, New is a button in the head rather than floating, the
   * notebook is picked from a rail beside the column rather than a drawer over it, and
   * the sheet is a panel beside the list rather than one from the floor (CSS decides
   * that last one).
   *
   * This is one of the few places the app reads the breakpoint in JS rather than in
   * CSS. The policy in `useMediaQuery` allows exactly this (a control whose *meaning*
   * changes with width) and what it protects against is elsewhere: the editor is an
   * uncontrolled CodeMirror view that must not be rebuilt, and nothing here is in its
   * tree.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);

  /*
   * How the list is drawn, the URL's `view`, seeded from the last one seen when the URL
   * has not said yet (`useNotesView`).
   *
   * The table is honoured only where a table makes sense: inside one notebook (columns
   * are its fields) and at desktop width (a phone has no room for columns). Everywhere
   * else the list is drawn, the menu shows that, and the choice is kept: the table is
   * back the moment there is a notebook to draw it for. The cards are honoured
   * everywhere the list is, a phone's included: a card needs no notebook (its fields
   * line is simply absent outside one) and a gallery of photos is good at phone width.
   *
   * A search leaves neither. Searching a table is looking for rows, and the columns are
   * why the table is open; searching the cards is looking for a picture. The matches
   * are drawn in the view (see `matchRows`). The list used to take over while searching,
   * and in a notebook drawn another way that was a different layout under the field at
   * every keystroke.
   */
  const view = useNotesView(viewParam);
  const tableOffered = !isMobile && notebookId !== undefined;
  const shownView: NotesViewMode = view === 'table' && !tableOffered ? 'list' : view;
  const tableMode = shownView === 'table';
  const cardsMode = shownView === 'cards';

  /* The table and the cards draw each match as the note's own row, so they ask for the rows. */
  const search = useQuery(searchQuery(debounced, filter, shownView !== 'list'));

  const [sheetOpen, setSheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /*
   * Which page the sheet is showing. One dialog that swaps its contents rather than a
   * second sheet over the first, which would dim the first behind the second and leave two
   * scrims on screen: Android's `FilterSheet` records the same choice.
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
   * and a notebook select in the sidebar doing its job: a phone's drawer left open over
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

  /**
   * Null means "not searching", which is distinct from searching and finding nothing.
   *
   * A search whose first answer is still on its way is searching too, with no results
   * yet (`awaiting`). It was read as not searching, which drew the notebook's unsearched
   * notes for the length of every request, so the list flickered as you typed. Later
   * requests keep the last answer on screen (`searchQuery`), so this is only the first.
   */
  const needle = debounced.trim();
  /*
   * Offline, the device's own index answers (`searchQuery`), so a search is a search
   * either way. What is left of "offline" here is a device with no index to ask (no
   * local library, or its file would not open) where the query fails for want of a
   * connection. The list then says so instead of "No matches", which would be a claim
   * about the notes rather than about the connection. The tag and notebook picks still
   * show: they are matched against lists already on the device.
   */
  const searchOffline = needle !== '' && search.isError && isOfflineError(search.error);
  const answered =
    search.data !== undefined && (shownView === 'list' || search.data.results.every((r) => 'note' in r));
  const awaiting = needle !== '' && !searchOffline && !answered;
  const results = needle === '' ? null : searchOffline || !answered ? [] : search.data.results;
  /*
   * What a search answered on this device could see, for the line under the matches.
   * Not while the matches on screen are the previous term's: the line is about the
   * answer it sits under.
   */
  const covered = results !== null && answered && !searchOffline && !search.isPlaceholderData ? search.data.local : undefined;
  /*
   * The matches as the table's rows or the cards, in the search's order, which is
   * relevance, so the headers show no sort while a search is on and the view's own order
   * comes back with the list. Holding a column order over the matches would be a claim
   * the search cannot back: it returns the best fifty, so "newest first" could leave out
   * the newest. The rows are only drawn once they are the view's: a search answered
   * before the view changed carries none (`answered`).
   */
  const matchRows = results?.flatMap((r) => ('note' in r ? [r.note] : [])) ?? null;
  /*
   * The matches on screen are the previous term's while the next one's request is out
   * (see `searchQuery`) and are dimmed for it. Only then: a search that has ended is a
   * query that never runs, and one that failed for want of a connection runs no further,
   * and `keepPreviousData` holds the last results as the placeholder of either for as
   * long as it stays that way. Read bare, that left the
   * notebook's own list dimmed after a search was cleared, until a reload.
   */
  const searchStale = needle !== '' && !searchOffline && search.isPlaceholderData;
  /** Whether the results will be headed by picks, which is when the notes need a caption too. */
  const picks = scopeMatches(debounced, tags.data ?? [], notebooks.data, selectedTags, notebook);
  const hasPicks = picks.tags.length > 0 || picks.notebooks.length > 0;

  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  /** What the cards draw: the matches while a search is on, the loaded notes otherwise. */
  const cardNotes = results !== null ? (matchRows ?? []) : notes;
  // The list's Load more asks for itself as it nears the bottom; see `useAutoLoad`. The
  // table has its own, on its own button.
  const autoLoad = useAutoLoad({
    enabled: list.hasNextPage && !list.isFetchingNextPage,
    loaded: notes.length,
    onLoad: () => void list.fetchNextPage(),
  });
  const total = list.data?.pages[0]?.total ?? null;

  /*
   * A field edited from a table cell.
   *
   * The row changes at once and the save follows, the way the note's own property list
   * behaves; a failure puts the row back and says so on the error line. The rest of the
   * list is refetched afterwards rather than patched, because the edit bumps the note's
   * updated date: under "Recently updated" the row then moves to the top, which is what
   * any edit does to that list and not something a table should quietly hide.
   *
   * The open note is the exception: its editor holds a draft that would write the old
   * value back over a direct save, so its edits go to that draft (`editOpenNoteField`)
   * and the editor saves them. The row is still patched here so the two agree at once.
   */
  const listKey = keys.notes(filter, ordering);
  /* A table drawing a search draws the search's rows, so an edit there patches those. */
  const searchKey = keys.search(debounced, filter, true);
  const patchRow = (noteId: string, def: FieldDef, value: FieldValue | null) => {
    queryClient.setQueryData(listKey, (data: Parameters<typeof patchNotePages>[0]) =>
      patchNotePages(data, noteId, (n) => patchNoteFields(n, def, notebook ?? '', value)),
    );
    queryClient.setQueryData(searchKey, (data: SearchAnswer | undefined) =>
      data && {
        ...data,
        results: data.results.map((r) =>
          'note' in r && r.id === noteId ? { ...r, note: patchNoteFields(r.note, def, notebook ?? '', value) } : r,
        ),
      },
    );
  };
  const editField = useMutation({
    mutationFn: ({ noteId, def, value }: { noteId: string; def: FieldDef; value: FieldValue | null }) =>
      actions.setNoteField(noteId, def, value),
    onMutate: async ({ noteId, def, value }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      await queryClient.cancelQueries({ queryKey: searchKey });
      const previous = queryClient.getQueryData(listKey);
      const previousSearch = queryClient.getQueryData(searchKey);
      patchRow(noteId, def, value);
      return { previous, previousSearch };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
      if (context?.previousSearch) queryClient.setQueryData(searchKey, context.previousSearch);
    },
    onSuccess: (updated) => {
      // Only a note already in the cache: reopening it should show what the table saved.
      if (queryClient.getQueryData(keys.note(updated.id))) {
        queryClient.setQueryData(keys.note(updated.id), updated);
      }
      // The saved row, placed, in every list, a refetch only where the field decides
      // membership or order. See `applySaveToLists`.
      applySaveToLists(queryClient, updated, { fields: true });
    },
  });
  const onEditCell = (noteId: string, def: FieldDef, value: FieldValue | null) => {
    if (editOpenNoteField(noteId, def.id, value)) {
      patchRow(noteId, def, value);
      return;
    }
    editField.mutate({ noteId, def, value });
  };

  /*
     The offline sentences below are about the list: a page of it never loaded on this
     device. A cell edit that failed for want of a connection is not that, and saying the
     list is incomplete to someone who just edited a cell would be wrong; the cells and the
     selection bar are locked offline anyway, so it can only be the edit that was in flight.
  */
  const error =
    list.error ?? (isOfflineError(search.error) ? null : search.error) ?? (isOfflineError(editField.error) ? null : editField.error);

  /*
   * Whether the rows on screen are the rows for the heading above them.
   *
   * The route commits before the list arrives (see the loader in `routes/notes.tsx`)
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

  const layout = useNotesLayout('/notes/$noteId', { mode: shownView });
  /*
   * The table and the cards with no note open are the whole window wide, and a header
   * laid out for a sidebar stretched with them: a search field a window wide. There the
   * header is one toolbar row (see `NoteListHead`). Beside an open note either is a
   * column again and keeps the stacked header, which is what fits.
   *
   * The cards take the table's shape rather than the list's, which is the one place they
   * do. In the list's 19rem column a gallery is one card across, a list of pictures; the
   * wall of them is the thing to look at, and "Select a note" beside it would be a pane
   * saying nothing next to one saying everything, the table's reason exactly.
   */
  const toolbarHead = shownView !== 'list' && !layout.open;

  /*
   * Which rows are picked for a bulk action (see `useSelection` for the rules). The rows
   * are the loaded notes in their drawn order, whichever way they are drawn; the open
   * note is the anchor a Shift-click ranges from until something else is picked; and any
   * change of scope drops the selection, since it names rows that are no longer on screen.
   */
  const rowIds = (shownView !== 'list' && matchRows ? matchRows : notes).map((n) => n.id);
  const scopeKey = JSON.stringify([filter, ordering, debounced]);
  const selection = useSelection(rowIds, {
    anchor: layout.open,
    resetKey: scopeKey,
  });
  /** The scope as it is now, for a drop's batch to check against the one it was made in. */
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  /*
   * Opening a note drops the selection too, as it does in Finder: a plain click or an
   * arrow key is browsing, and a selection left standing behind the note you moved to
   * would be one an action could reach with its rows out of view. The modifier clicks
   * and the checkboxes do not navigate, so they are not this.
   */
  const { clear: clearSelection } = selection;
  useEffect(() => {
    clearSelection();
  }, [layout.open, clearSelection]);

  /** How one note's row or card takes part in the selection; the same for both. */
  const rowSelection = (id: string): RowSelection => ({
    selected: selection.has(id),
    active: selection.active,
    onPick: (opts) => selection.pick(id, opts),
  });

  /** Escape and Cmd/Ctrl+A on the list are the selection's; the arrows stay the list's. */
  const onListKeysWithSelection = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && selection.active) {
      event.preventDefault();
      selection.clear();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && (results === null || shownView !== 'list')) {
      event.preventDefault();
      selection.selectAll();
      return;
    }
    onListKeys(event);
  };

  /*
   * The bulk actions. Each writes, tells the open note's draft if it was among the rows
   * (`editOpenNoteFiling`: the next autosave would otherwise put the old filing back),
   * then refetches everything the change reaches: the lists, any search, the cached
   * notes, the counts on the rail. Moving and trashing drop the selection (the rows
   * leave the list, or the job is done) while a tag change keeps it, since the sheet
   * stays open for the next one. Trashing is confirmed inline, unlike the single
   * note's Delete, which has the ⋯ menu as its deliberate second step; a bar's button is
   * one click, and forty notes is a blast radius worth naming first.
   */
  const [pendingTrash, setPendingTrash] = useState(false);
  /** Which of the bar's sheets is open: where to move the selection, or its tags. */
  const [bulkSheet, setBulkSheet] = useState<'move' | 'tags' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  async function runBulk(action: () => Promise<void>) {
    setBulkBusy(true);
    setBulkError(null);
    try {
      await action();
    } catch (err) {
      setBulkError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }
  async function refetchAfterBulk() {
    await queryClient.invalidateQueries({ queryKey: ['notes'] });
    void queryClient.invalidateQueries({ queryKey: ['search'] });
    void queryClient.invalidateQueries({ queryKey: ['note'] });
    invalidateNoteMembership(queryClient);
  }
  const trashSelected = () =>
    runBulk(async () => {
      const ids = selection.ids;
      await actions.trashNotes(ids);
      setPendingTrash(false);
      selection.clear();
      // The open note went with them: leave it before its query learns it is gone.
      if (layout.open && ids.includes(layout.open)) {
        void navigate({ to: '/notes', search: (p) => p });
      }
      void queryClient.invalidateQueries({ queryKey: ['trash'] });
      await refetchAfterBulk();
    });
  const moveSelected = (target: string | null) =>
    runBulk(async () => {
      const ids = selection.ids;
      await actions.moveNotes(ids, target);
      setBulkSheet(null);
      if (layout.open && ids.includes(layout.open)) {
        editOpenNoteFiling(layout.open, { notebook: target });
      }
      selection.clear();
      await refetchAfterBulk();
    });
  const tagSelected = (change: { add?: string[]; remove?: string[] }) =>
    runBulk(async () => {
      const ids = selection.ids;
      await actions.tagNotes(ids, { add: change.add, remove: change.remove });
      if (layout.open && ids.includes(layout.open)) {
        const add = change.add ?? [];
        const remove = new Set(change.remove ?? []);
        editOpenNoteFiling(layout.open, {
          tags: (current) => [
            ...current.filter((t) => !remove.has(t)),
            ...add.filter((t) => !current.includes(t)),
          ],
        });
      }
      await refetchAfterBulk();
    });
  /*
   * Where the list is, as a navigation target: the open note when there is one. Changing
   * how the list is drawn must not close a note, unlike a filter, which can take the note
   * out of the list and so goes back to `/notes`.
   */
  const withView = (next: NotesViewMode, replace: boolean) => {
    const search = (prev: Record<string, unknown>) => ({ ...prev, view: next });
    return layout.open
      ? ({ to: '/notes/$noteId', params: { noteId: layout.open }, search, replace, resetScroll: false } as const)
      : ({ to: '/notes', search, replace, resetScroll: false } as const);
  };
  /*
   * A URL that does not name a view is given the one on screen, in place.
   *
   * This is what makes Back work. A silent URL means "the view last seen", and that
   * changes every time the toggle is pressed, so a silent history entry would come back
   * drawn the new way, not the way it was left. Once each entry names its own view,
   * Back, Forward, a reload and a jump through the history menu all land on what was
   * there. Replaced, not pushed: it records the entry, it is not a move.
   *
   * Everywhere, now. It was only inside a notebook on a desktop, where the table could
   * be drawn, so that `/notes` stayed a clean link and a phone's URLs were never
   * touched; the cards are a second drawing in every list at every width, so a silent
   * entry anywhere is one Back could bring back wrong.
   */
  const viewUnsaid = viewParam === undefined;
  useEffect(() => {
    if (viewUnsaid) void navigate(withView(view, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewUnsaid, view, layout.open]);
  /*
   * The toggle is a move of its own, pushed, so Back undoes it, which it can, now that
   * the entry it goes back to says which view it had. The remembered view follows the
   * URL (`useNotesView`), so there is nothing else to write.
   */
  const chooseView = (next: NotesViewMode) => void navigate(withView(next, false));
  const columns = noteColumns(fieldDefs.data ?? []);
  const totalIds = columns.filter(totalable).map((c) => c.id);
  const fieldTotals = useQuery({ ...fieldTotalsQuery(filter, totalIds, ordering), enabled: tableMode && totalIds.length > 0 });
  // Which rows the footer sums, and what it calls them; see `tableTotalsFor`.
  const tableTotals = tableMode
    ? tableTotalsFor({
        ids: new Set(totalIds),
        searchRows: matchRows,
        whole: fieldTotals.data,
        libraryWhole,
        loaded: notes,
        hasNextPage: list.hasNextPage,
      })
    : undefined;
  /*
   * Whether a sort chosen here is remembered for the notebook (`rememberSort`). Not while
   * a view is open: the order on screen is then the view's, edited or not, and a re-sort
   * made to look at a view a different way would otherwise change how the plain notebook
   * opens next time, which nobody asked of it. Saving the view is how that order is kept.
   */
  const remembersSort = openView === undefined;
  /** A column header was clicked: write the order it asks for. */
  const sortBy = (target: SortTarget) => {
    if (remembersSort) rememberSort(notebook, nextColumnSort(target, { sort, order, sortField }));
    void navigate({
      to: '/notes',
      search: (prev) => ({ ...prev, ...nextColumnSort(target, prev) }),
    });
  };
  /**
   * While the library is still arriving on this device, an empty list is not an empty
   * account: the rows are on their way. Said in the list's own words, and the offer of
   * sample notes withheld, since filling an account whose notes are a page away would be
   * the wrong answer to the wrong question.
   */
  const arriving = useLibraryArriving();
  /**
   * How many notes the whole account holds, once that is known (`useLibraryTotal`), and
   * whether the list on screen is the whole account. Together they are what tells an
   * empty account from an empty notebook or a search with no matches.
   */
  const wholeAccount = showsWholeAccount({ notebook, tag, field, from, to, q });
  /*
   * Asked only while the answer can change what is drawn: everything below acts on an
   * account with no notes, and on All notes the loaded rows are the account's, so a list
   * with a row in it has nothing to ask. Nor while the list's first load is pending, or
   * while it still shows the rows of the place it came from (`stale`): an empty notebook
   * or a search that matched nothing, on the way back to All notes: its rows say nothing
   * about the account then, and asking would count a whole archive (or, on a device
   * with no library, send a second request beside the list's own) on every open, for an
   * answer only an empty account can use. The empty state comes one count later for it,
   * and nothing flashes in between: on All notes the list's empty line says nothing
   * (`emptyMessage`).
   */
  const libraryTotal = useLibraryTotal(wholeAccount && !list.isPending && !stale && notes.length === 0);
  /**
   * The account holds no notes at all, and the list is the whole of it. On a phone the
   * list's empty line gives way to `EmptyLibrary`; on a desktop the workspace pane draws
   * it (`routes/notes.index.tsx`) and the list column says nothing, since a "No notes
   * yet." line beside a "No notes yet" heading is the same fact twice, a column apart.
   * Never in the table, which needs a notebook, and so never in a scope this can be true
   * of. Held while a note asked for from the empty state is being made; see
   * `useHoldWhileCreating`.
   */
  const libraryEmpty = useHoldWhileCreating(libraryTotal === 0 && wholeAccount && results === null && !error);
  const emptyLibraryInList = libraryEmpty && isMobile;
  /** The list's empty state, in words; both renderings say the same thing. */
  const emptyMessage =
    notes.length === 0 && !error && !list.isPending && arriving
      ? arriving.stage === 'opening'
        ? 'Opening your notes…'
        : 'Copying your notes to this device…'
      : notes.length === 0 && !error && !list.isPending
      ? tag
        ? `No notes tagged ${tag}.`
        : fieldFilters.length > 0
          ? 'No notes match those fields.'
          : notebook === UNFILED
            ? 'Nothing in your inbox.'
            : notebook
              ? `No notes in ${notebook}.`
              : // Never on All notes. Until the account is known to be empty the list's
                // rows can be empty for a moment while the account's are not, and the
                // line then is the flash the empty state takes care not to make; once it
                // is known, `EmptyLibrary` says it, in place of the list on a phone, in
                // the pane beside this column on a desktop. A date range keeps the line
                // it always had.
                !wholeAccount
                ? 'No notes yet.'
                : null
      : null;

  /*
   * The preview-only offer of sample notes (`SampleNotes`), on a preview whose stores are
   * its own. Only on All notes with nothing applied, and only for an account known to be
   * empty: an empty notebook or filter is not an empty account, and filling it from there
   * would read as filling that notebook. Not while the total is unknown, which is also
   * while the library is still arriving.
   */
  const offerSampleNotes = Boolean(config.data?.ownStores) && libraryEmpty;

  /**
   * The same for a search drawn as a table or as cards, in the sidebar's words for each
   * case. Nothing while the first answer is on its way: "No matches" would be a claim
   * about the notes, and the header's count already says it is searching.
   */
  const searchEmpty = searchOffline ? 'Search needs a connection.' : awaiting ? null : 'No matches.';
  /*
   * Why a match is in the table when its row cannot show it: the word was in one of the
   * note's files, which have no column. A match in a field or a tag is in that column,
   * and one in the body is the note itself, as in the sidebar's results.
   */
  const matchHints = new Map(
    (results ?? []).flatMap((r) => (r.matchedFile ? [[r.id, `in ${r.matchedFile}`] as const] : [])),
  );
  /*
   * The same for a card, which draws less than a table row: a match in a file says so as
   * the table's does, and so does one in a field or a tag, as the sidebar's results do.
   * The table has a column for each field and its tags; a card has neither, and its
   * fields line is cut to one line, often before the field that matched. A match in the
   * body is the note itself, as in the table. Built on `matchHints`, so the file's
   * wording is written once; a file match wins over the rest, as it is listed last.
   */
  const cardHints = new Map<string, string>([
    ...(results ?? []).flatMap((r): [string, string][] =>
      r.matchedField ? [[r.id, `in ${r.matchedField}`]] : r.matchedTag ? [[r.id, `tagged ${r.matchedTag}`]] : [],
    ),
    ...matchHints,
  ]);

  /**
   * Where the list is, for the heading: see `scopeLabel` for the rule, which is the
   * rail's rule, so the heading and the row you picked agree. At every width: on a desktop
   * the rail marks the place, but the rail can be a strip of icons, and the column has to
   * say what it holds on its own.
   *
   * A lone tag with no notebook is a place, and then it is the heading rather than a chip:
   * the chip under the header would be the same word twice on adjacent lines, the reason
   * a notebook has no chip. The sheet still lists it, since a surface that claims to show
   * everything applied has to, and All notes in the rail is the way out of it. Every other
   * tag stays a chip: the chips are what can be taken off, and a heading listing several
   * would either duplicate them or truncate.
   */
  /*
   * With a view open, the view is where you are: its name is the heading and its
   * notebook the line over it, in the notebook's own spelling rather than the address's
   * (a link may say `receipts`), as the rail draws it.
   */
  const notebookName = notebooks.data?.notebooks.find((nb) => nb.id === notebookId)?.name ?? notebook;
  const heading = openView ? openView.name : scopeLabel(notebook, selectedTags);
  const eyebrow = openView ? notebookName : undefined;
  const tagAsPlace = tagPlace(notebook, selectedTags);
  const chipTags = tagAsPlace ? [] : selectedTags;

  /**
   * What the list is showing, in three forms. Both breakpoints' headers read it.
   *
   * The total, not "50 of 900 notes": how many are loaded so far is a paging detail and
   * the Load more button says it (see `loadMoreLabel`). The header shares its row with
   * four controls, and the longer string was the one thing in it that truncated.
   */
  /** The URL names a notebook that does not exist; see `NotebookMissing`. */
  const notebookMissing = isNotebookMissing(notebook, notebooks, libraryWhole);
  /*
   * Drawn in the list's place only while nothing is being searched. A search is the person
   * looking for something, so its results, its count and the tags and notebooks whose names
   * match (`ScopeMatches`, which can be the very notebook they meant) draw as they would
   * anywhere; clearing the query brings the state back.
   */
  const showNotebookMissing = notebookMissing && results === null;
  const counting = loading || (arriving !== null && notes.length === 0);
  const noteCount = total ?? notes.length;
  const countLabel = showNotebookMissing
    ? // A count of a notebook that does not exist would be a claim about nothing.
      null
    : results !== null
      ? awaiting
        ? 'Searching…'
        : `${results.length} matches`
      : counting
        ? 'Loading…'
        : // Formatted as the menu under it formats it: "1,234 notes ⌄" over "Export these
          // 1,234 notes", and one note over "Export this note".
          noteCount === 1
          ? '1 note'
          : `${noteCount.toLocaleString()} notes`;

  /* The count as a menu: export the slice, or select it (see `offersCountMenu` for when,
     and `countMenuItems` for what). */
  const exportRunning = useExportRunning();
  const offline = useOffline();
  /*
     The one control on this page that makes something, faded while the plan has ended
     (MAK-108): the server refuses the note, and a New that made one on the device and
     took it back when the refusal came would read as the app breaking rather than the
     plan ending. Faded with the reason rather than withdrawn, the rule offline controls
     follow; the banner above says the rest.
  */
  const { inactive: planInactive } = usePlan();
  const noNewNotes = planInactive ? READ_ONLY_TIP : undefined;
  const countMenu =
    offersCountMenu({
      searching: results !== null,
      notebookMissing: showNotebookMissing,
      loading: counting,
      total: noteCount,
    })
      ? countMenuItems({
          total: noteCount,
          everything: !isFiltered,
          shown: rowIds.length,
          more: list.hasNextPage,
          exportRunning,
          offline,
          onExport: () =>
            startExport({
              tags: filter.tag,
              notebook: filter.notebook,
              fields: filter.field,
              from: filter.from,
              to: filter.to,
              sort: sort ?? DEFAULT_NOTE_SORT,
            }),
          onSelectAll: selection.selectAll,
        })
      : undefined;

  /*
   * The list as a saved view would keep it, and what can be done with that.
   *
   * `edited` is the open view against the address: the search text is not part of a view
   * and never counts (see `views.ts`), and a layout not yet written in counts for nothing
   * either (`sameViewQuery`). Saving a new view is offered only inside a notebook, where
   * views live, and only when the list is narrowed or ordered at all (`narrowsList`): a
   * plain notebook saved as a view would be a second row for the row above it.
   *
   * "Ordered" means ordered otherwise than the notebook remembers. The remembered order
   * is written into the address on arrival and by the rail's own link (`scopeOf`), so the
   * notebook in that order is the plain notebook, as its row opens it; counted as a
   * narrowing, every notebook ever re-sorted grew a row above its list holding only
   * "Save view", there whenever it was opened and again after a view in it was deleted.
   *
   * Not while the search box has text, either. A view leaves the search out on purpose
   * (see `views.ts`), so one saved mid-search would open to more notes than were on
   * screen when it was saved, with nothing to have said so; the filter sheet hides its
   * tag and field rows while searching for the same kind of reason. The Edited line is
   * not held back: a search inside a view is not an edit of it.
   */
  const listAddress = { tag, field, sort, order, sortField, from, to, view: viewParam ?? view };
  const viewEdited = openView !== undefined && !sameViewQuery(openView.query, viewQueryOf(listAddress));
  const remembered = rememberedSort(notebook);
  const inRememberedOrder =
    sort === remembered.sort && order === remembered.order && sortField === remembered.sortField;
  const narrowed = narrowsList(
    inRememberedOrder ? { ...listAddress, sort: undefined, order: undefined, sortField: undefined } : listAddress,
  );
  const canSaveView =
    notebookId !== undefined && saved === undefined && !showNotebookMissing && q.trim() === '' && narrowed;
  const viewState: 'unsaved' | 'edited' | null = viewEdited ? 'edited' : canSaveView ? 'unsaved' : null;

  /** A view the server has answered, into the list the rail and the heading read, at once. */
  const holdView = (made: NotebookView) =>
    queryClient.setQueryData(keys.views(), (list: NotebookView[] | undefined) =>
      list?.some((v) => v.id === made.id) ? list.map((v) => (v.id === made.id ? made : v)) : [...(list ?? []), made],
    );
  /*
   * The list saved as a new view, then opened as one: the address is already the view's,
   * so opening it is only its id beside the filters, in place, with the open note left
   * open and the search text left as typed.
   *
   * Only if the person is still where the save was made: the same notebook, and the same
   * view open as when they pressed (none, for Save view; the edited one, for Save as
   * new). The save waits for the row to land (seconds, in a tab that does not hold the
   * library), and in that time they may have gone elsewhere; the id of a view of the
   * first notebook written into the second one's address would name a view that is not
   * there. The view is saved either way and listed under its notebook. Focus moves to
   * the heading only when the id is written, or it would wait on a view the page never
   * opened and jump the next time someone opened it from the rail; it is asked for
   * inside the address's callback because the heading renders before `navigate`
   * resolves, and the effect that moves focus runs on that render.
   */
  const createView = async (name: string) => {
    if (notebookId === undefined || !notebook) return;
    const madeIn = { name: notebook, saved };
    const made = await actions.createView({ notebookId, name, query: viewQueryOf(listAddress) });
    holdView(made);
    madeHere.current.set(made.id, Date.now());
    await navigate({
      to: '.',
      search: (prev) => {
        if (typeof prev.notebook !== 'string' || !sameNotebookName(prev.notebook, madeIn.name)) return prev;
        if (prev.saved !== madeIn.saved) return prev;
        focusOn('heading', made.id);
        return { ...prev, saved: made.id };
      },
      replace: true,
      resetScroll: false,
    });
  };
  /*
   * The open view takes what the list shows now; the Edited line goes with the match, and
   * the Save that was pressed with it, so focus moves to the heading as a new view's does.
   */
  const saveView = async () => {
    if (!openView) return;
    const id = openView.id;
    holdView(await actions.updateView(id, { query: viewQueryOf(listAddress) }));
    focusOn('heading', id);
  };
  /*
   * Back to the view as it is kept. Replaced rather than pushed, since it undoes the
   * entries the edit made rather than being a move of its own. The search text stays: it
   * was never the view's to take away. To the list rather than `.`, as every filter is:
   * the view's filters may not include the note that is open.
   */
  const revertView = () => {
    if (!openView || !notebook) return;
    void navigate({ to: '/notes', search: { ...viewSearch(notebook, openView), q: q || undefined }, replace: true });
  };
  /*
   * The open view's own menu, beside its name: Rename, in the name's place, and Delete,
   * through the confirm above the list. Both need the server, so the ⋯ fades offline
   * with the reason, as a note's does, rather than leaving the head.
   */
  const [renamingView, setRenamingView] = useState(false);
  const [deletingView, setDeletingView] = useState(false);
  /*
   * Where focus goes once a view's inline field has closed, since the control that was
   * pressed is gone by then. A save or a rename moves it to the heading, which is what
   * changed and is read out; leaving a rename gives it back to the ⋯ it was opened from,
   * a new element by then. Without this both ended on the page's body.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const viewMenuRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<{ to: 'heading' | 'menu'; view: string } | null>(null);
  /*
   * Asking for focus is a render of its own (`askFocus`), so the effect below runs once
   * the intent is written whatever else the action changed or did not. It used to wait
   * on what the answer happened to change (the view's id, name or `updatedAt`), and a
   * save into the open view in the tab holding the library changed none of them after
   * the intent: the row had landed and been drawn before the action answered. Focus fell
   * to the body with the Save it was in, and the intent pulled focus to the heading at
   * some later, unrelated render.
   */
  const [focusAsked, askFocus] = useReducer((n: number) => n + 1, 0);
  const focusOn = (to: 'heading' | 'menu', view: string) => {
    focusAfter.current = { to, view };
    askFocus();
  };
  /*
   * Not while the filter sheet is open: it is a modal dialog, the heading is under it and
   * inert, and a focus call there lands nowhere. A save made from the sheet closes it
   * (`viewActions`), and the dialog's close hands focus back to the filter button in the
   * sheet's own effect, which runs before this one, so the heading still has the last word.
   */
  useEffect(() => {
    const want = focusAfter.current;
    if (!want || renamingView || sheetOpen || openView?.id !== want.view) return;
    focusAfter.current = null;
    (want.to === 'heading' ? headingRef.current : viewMenuRef.current)?.focus();
  }, [openView?.id, openView?.name, focusAsked, renamingView, sheetOpen]);
  const [viewBusy, setViewBusy] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  // Another view, or none: what was half done to the last one is not for this one.
  useEffect(() => {
    setRenamingView(false);
    setDeletingView(false);
    setViewError(null);
  }, [openView?.id]);
  const renameView = async (name: string) => {
    if (!openView) return;
    holdView(await actions.updateView(openView.id, { name }));
    focusOn('heading', openView.id);
    setRenamingView(false);
  };
  const cancelRename = () => {
    if (openView) focusOn('menu', openView.id);
    setRenamingView(false);
  };
  /*
   * Deleted, then out to the notebook as it is: its own row's address, in the order the
   * notebook remembers. The view's filters go with it rather than staying as an unnamed
   * narrowing, since what was asked for is the view gone, and a list still narrowed by
   * it with nothing to say so would look like the delete had not happened.
   */
  const deleteOpenView = async () => {
    if (!openView) return;
    const gone = openView;
    setViewBusy(true);
    setViewError(null);
    try {
      await actions.deleteView(gone.id);
      queryClient.setQueryData(keys.views(), (list: NotebookView[] | undefined) => list?.filter((v) => v.id !== gone.id));
      setDeletingView(false);
      void navigate({
        to: '/notes',
        search: (prev) => ({
          ...prev,
          saved: undefined,
          tag: undefined,
          field: undefined,
          from: undefined,
          to: undefined,
          ...rememberedSort(notebook),
        }),
      });
    } catch (err) {
      setViewError((err as Error).message);
    } finally {
      setViewBusy(false);
    }
  };
  const viewMenu = openView ? (
    <OverflowMenu
      label={`Actions for ${openView.name}`}
      tip={offline ? VIEW_NEEDS_CONNECTION : 'View actions'}
      triggerRef={viewMenuRef}
      disabled={offline}
      className="title-menu"
      triggerClassName="title-menu-trigger"
      items={[
        { label: 'Rename', onSelect: () => setRenamingView(true) },
        { separator: true, label: null },
        { label: 'Delete', tone: 'danger', onSelect: () => setDeletingView(true) },
      ]}
    />
  ) : undefined;
  const viewRename =
    openView && renamingView ? (
      <ViewNameField
        key={openView.id}
        initial={openView.name}
        label={`New name for ${openView.name}`}
        commitLabel="Rename"
        className="view-rename"
        inputClassName="view-rename-field"
        stacked={!isMobile}
        onCommit={renameView}
        onCancel={cancelRename}
      />
    ) : undefined;

  /*
   * In the filter sheet, a save closes the sheet once it has landed. The sheet is a modal
   * dialog over the heading, and the heading is the one place that names what was saved;
   * left open, the sheet lost the actions it had just shown (there is nothing edited or
   * unsaved any more) and showed nothing in their place. Revert leaves it open: what it
   * changes is the chips, which the sheet shows.
   */
  const viewActions = (inSheet = false) =>
    viewState && (
      <ViewActions
        // A new state is a new control: a name half typed for one is not for the other.
        key={`${viewState}:${openView?.id ?? ''}`}
        state={viewState}
        viewName={openView?.name}
        offline={offline}
        searching={q.trim() !== ''}
        onCreate={inSheet ? (name) => createView(name).then(closeSheet) : createView}
        onSave={inSheet ? () => saveView().then(closeSheet) : saveView}
        onRevert={revertView}
      />
    );

  const selectionExportLabel = exportRunning
    ? 'Export: another export is running'
    : selection.ids.length === 1
      ? 'Export this note'
      : `Export ${selection.ids.length} notes`;

  const createNote = useCreateNote();
  /**
   * Where a note made from this list goes. Every active tag, not just one: with two tags
   * filtered, a note carrying only the first is still filtered out of the list it was
   * created in. UNFILED is a filter sentinel, not a notebook name: a note created while
   * viewing it belongs in no notebook. Nor does one made beside "Notebook not found":
   * filing it under the name would have the server create the notebook the screen has
   * just said does not exist, on the strength of a stale link. It goes where it would
   * from All notes, which is where "Show all notes" leads.
   */
  const filing = {
    tags: tag ?? [],
    notebook: notebook === UNFILED || notebookMissing ? null : (notebook ?? null),
  };
  /**
   * The New button and the phone's +. Carries the active filter onto the new note. On a
   * free account at the free plan's count the action refuses before it makes anything
   * and `FreeNotesNotice` says so; pressable rather than disabled, so the reason reaches
   * a phone, where a disabled floating + would say nothing and a tip is never drawn.
   */
  const newNote = () => createNote(filing);

  /*
   * Files let go on the list become one note each, filed as New would file them (see
   * `listDropZone` for the rule that the target decides, and `file-notes.ts` for the
   * writes). The zone goes on the whole column, not the list alone: the head and the
   * search field are part of the pane a person aims at, and a file let go on the count
   * going to the browser instead would be the stray drop the window's guard exists for.
   * The sentence is drawn over the column while a drag is on it (`.list-drop-hint`), and
   * names the place as the heading does; nothing is named when the notes go nowhere.
   * Refused, with the pointer, while the plan has ended: the server refuses every write.
   * A drop while an earlier batch is still landing is taken and waits its turn.
   *
   * The notes made are selected once they are in the list, so the bar offers Move, Tags
   * and Delete on exactly these: filing them somewhere else, or taking a wrong drop back,
   * is then one press, with no sheet asked for before the drop. Only while the list is
   * still the one dropped on: twelve uploads take a while, and a selection put over
   * whatever the person has picked or opened meanwhile, in some other notebook, would
   * be the bar offering actions on rows they cannot see.
   *
   * One file is the exception: its note opens instead, as New opens the note it made.
   * The bar's actions are what a batch needs, since there is no other way to file twelve
   * notes at once; a single note is filed from its own head, and a selection of one
   * left the person looking at a checkbox and "Select a note" beside the very note they
   * had just made. Under the same rule, and the search kept, so the list stays the one
   * dropped on; and only while the person is still at the address they dropped from,
   * search and all. A selection landing late is harmless, but a navigation landing late
   * takes the editor from a note opened or begun with New while the upload ran, or the
   * page from someone who went to Settings or the trash. The router's own location, read
   * when the upload lands: refs of this component's stop moving once leaving `/notes`
   * unmounts it, so `scopeRef` alone would pass for a list left and come back to under
   * another filter.
   */
  const asideRef = useRef<HTMLElement>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const dropPlace = filing.notebook ?? (filing.tags.length > 0 ? filing.tags.join(', ') : null);
  // The listeners go on once; what they decide with is read fresh from here each time.
  const dropTarget = useRef({ accept: (n: number): string | null => null, onFiles: (_files: File[]) => {} });
  dropTarget.current = {
    accept: (count) => (planInactive ? null : dropSentence(count, dropPlace)),
    onFiles: (files) => {
      const droppedIn = scopeRef.current;
      const droppedAt = router.state.location.href;
      void notesFromFiles(files, filing, dropPlace, 'list', queryClient).then((ids) => {
        const [first] = ids;
        if (!first || scopeRef.current !== droppedIn) return;
        if (files.length > 1) selection.select(ids);
        else if (router.state.location.href === droppedAt) void navigate({ to: '/notes/$noteId', params: { noteId: first }, search: (p) => p });
      });
    },
  };
  useEffect(() => {
    const zone = asideRef.current;
    if (!zone) return;
    return listDropZone(zone, {
      accept: (count) => dropTarget.current.accept(count),
      onHover: setDropHint,
      onFiles: (files) => dropTarget.current.onFiles(files),
    });
  }, []);

  return (
    <div className={layout.className} style={layout.style} ref={layout.containerRef}>
      <aside className={dropHint ? 'sidebar dropping' : 'sidebar'} ref={asideRef}>
        {/* What letting go will do, over the column while a file is dragged across it. Not
            a live region: it changes with every pointer move, and a drag is sighted work.
            `pointer-events: none`, or crossing onto it would read as leaving the column. */}
        {dropHint && (
          <div className="list-drop-hint" aria-hidden="true">
            <span>{dropHint}</span>
          </div>
        )}
        <NoteListHead
          count={countLabel}
          countMenu={countMenu}
          title={heading}
          eyebrow={eyebrow}
          titleMenu={viewMenu}
          renaming={viewRename}
          headingRef={headingRef}
          query={q}
          onQuery={setQuery}
          onArrowDown={() => enterList(listRef.current ?? tableRef.current)}
          fieldRef={searchRef}
          searchOpen={searchOpen}
          /* Behind an icon on a phone; a permanent row on a desktop. Passing the opener or
             not is how the header is told which (see `NoteListHead`). */
          onOpenSearch={isMobile ? () => setSearchOpen(true) : undefined}
          /*
           * Closing clears the query. A closed field over a live `q` is a list narrowed
           * by something with nothing on screen to say so: the same invisible-filter
           * failure the chips below exist to prevent. On a desktop the field never closes,
           * and this is what Escape in it does.
           */
          onCloseSearch={() => {
            setSearchOpen(false);
            setQuery('');
          }}
          toolbar={toolbarHead}
          onOpenFilters={() => setSheetOpen(true)}
          filterRef={filterRef}
          onOpenMenu={isMobile ? () => setDrawerOpen(true) : undefined}
          filtered={sheetFiltered}
          /* Not offered while searching: results come back ranked by relevance, and
             reordering them by date would throw away that ranking. The list hides it;
             the table and the cards fade it, since there it shares a row with the search
             field and leaving would slide the field under the typing. Nothing else is lost with
             it: Settings, which used to share this corner, is on the drawer's floor. */
          sort={
            results === null || shownView !== 'list' ? (
              <NotesSort
                notebook={notebook}
                remember={remembersSort}
                sort={sort}
                order={order}
                sortField={sortField}
                fields={fieldDefs.data ?? []}
                disabledReason={results !== null ? 'matches are in order of relevance' : undefined}
              />
            ) : null
          }
          /* At every width, since the cards are drawn at every width; the table is
             offered everywhere and faded with the reason where it cannot be drawn. A
             phone's reason first: it holds inside a notebook too. */
          view={
            <NotesViewMenu
              value={shownView}
              requested={view}
              onChange={chooseView}
              tableDisabledReason={
                isMobile
                  ? 'Needs a wider screen than a phone'
                  : notebookId === undefined
                    ? 'Choose a notebook to see its fields as columns'
                    : undefined
              }
            />
          }
          /* New is a floating button on a phone (below) and the end of this row on a
             desktop, where a column has nothing for a button to float clear of.

             Outlined rather than filled while the account is empty. The pane beside it
             then draws `EmptyLibrary`, whose import is the view's one filled control
             (it is the thing that screen is for) and two fills a column apart compete
             for the same glance. New stays where it always is, only quieter. Outlined too
             beside "Notebook not found": a filled New there reads as the answer to a
             missing notebook, and the note it makes goes to no notebook (see `newNote`). */
          action={
            isMobile ? undefined : (
              <Button
                variant={libraryEmpty || notebookMissing ? 'secondary' : 'primary'}
                disabled={planInactive}
                tip={noNewNotes}
                onClick={() => void newNote()}
              >
                New
              </Button>
            )
          }
        />

        {error &&
          (isOfflineError(error) ? (
            /* No copy on the device: the list was never loaded here, or its next page
               was never reached. Muted, like the note's own version of this: it loads by
               itself when the connection returns. */
            <p className="muted small">
              {notes.length > 0
                ? "The rest of this list isn't available offline."
                : "This list hasn't been opened on this device, so it isn't available offline."}
            </p>
          ) : (
            <p className="bad small">{(error as Error).message}</p>
          ))}
        {/* The cell edit that was in flight when the connection went: its `onError` puts
            the old value back, and without this the cell would just snap back with no
            reason given. Past tense rather than "you're offline", because it stays until
            the next edit and the connection may be back long before that. */}
        {isOfflineError(editField.error) && (
          <p className="muted small">That change wasn’t saved: the connection dropped.</p>
        )}
        {bulkError && <p className="bad small">{bulkError}</p>}
        {viewError && <p className="bad small">{viewError}</p>}

        {/*
            Under the header rather than only inside the sheet, so what is narrowing the
            list is readable without opening anything, and removable without it too.

            No notebook chip here: the heading above already names it, and the chip
            repeated that word for word on the next line, spending a row of a phone screen
            to say it twice. The sheet still shows it, because a surface that claims to
            list everything applied has to.
        */}
        <ActiveFilters
          tags={chipTags}
          fields={fieldFilters}
          fieldDefs={fieldDefs.data ?? []}
          from={from}
          to={to}
          trailing={viewActions()}
        />

        {/* Above the list, where the trash view puts its confirms: a row is too narrow to
            hold a question and two buttons, and the count is what is being decided. */}
        {pendingTrash && selection.active && (
          <Confirm
            label="Confirm delete notes"
            question={`Delete ${selection.ids.length} ${selection.ids.length === 1 ? 'note' : 'notes'}?`}
            detail="They go to the trash, and can be restored from there."
            busy={bulkBusy}
            onCancel={() => setPendingTrash(false)}
            actions={[
              { label: 'Delete', busyLabel: 'Deleting…', tone: 'danger', onConfirm: trashSelected },
            ]}
          />
        )}

        {/* The view's delete, in the same slot and for the same reason: the question is
            about something on screen (the heading names the view), and a modal would
            cover it. Its notes are untouched, which is the thing worth saying. */}
        {deletingView && openView && (
          <DeleteViewConfirm
            name={openView.name}
            busy={viewBusy}
            onCancel={() => setDeletingView(false)}
            onConfirm={() => void deleteOpenView()}
          />
        )}

        <MoveSheet
          open={bulkSheet === 'move'}
          onClose={() => setBulkSheet(null)}
          count={selection.ids.length}
          notebooks={notebooks.data}
          busy={bulkBusy}
          onPick={(target) => void moveSelected(target)}
        />

        <TagsSheet
          open={bulkSheet === 'tags'}
          onClose={() => setBulkSheet(null)}
          notes={notes.filter((n) => selection.has(n.id))}
          suggestions={tags.data?.map((t) => t.name) ?? []}
          busy={bulkBusy}
          onChange={(change) => void tagSelected(change)}
          colorOf={tagColor}
        />

        {isMobile && (
          <NotebookDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            notebook={notebook}
            selectedTags={selectedTags}
            notebooks={notebooks}
            trashed={trashed}
            tags={tags.data ?? []}
            views={views.data}
            saved={saved}
            email={session?.user.email ?? ''}
            onSignOut={signOutAndLeave}
          />
        )}

        <Sheet
          open={sheetOpen}
          onClose={closeSheet}
          anchor={filterRef}
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
            // dates too: a button whose blast radius is off screen.
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
                  A row per filter, each opening a page of its own, the shape Android's
                  sheet settled on, and for the reason its root page stays readable: the
                  tag picker is a find field and an unbounded list, the dates are five
                  rows plus two labelled fields, and the fields page is a control per
                  definition. Inlined, any one is taller than everything else here put
                  together.

                  Neither the notebook nor the sort is among them. The notebook is a
                  place you go, so it is in the drawer or the rail; sort changes the
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

              {/*
                  The list as a view, on a phone, where the sheet is where the filters are
                  set and the chips row is behind it. Under the filters it would keep,
                  after a rule, since it is about all of them rather than one more of them.
                  Not at desktop width: the sheet is a panel beside the list there, and the
                  same actions are already in view at the end of the chips.
              */}
              {isMobile && viewState && (
                <>
                  <hr className="sheet-rule" />
                  <div className="sheet-view-actions">{viewActions(true)}</div>
                </>
              )}
            </>
          )}

          {/*
              Done only on the root.

              A sub-page had one too, which offered two ways out that did different
              things (back to the filters, or out of the sheet entirely) from two
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
          * with it: a "new note" button floating over the note you are reading would make
          * one every time a thumb reached for the scroll bar.
          *
          * Not over an empty account's state, which has its own New note a thumb's reach
          * away: the + beside it was a second filled control next to the import (the one
          * the desktop steps its New down to avoid) and a second button named "New note"
          * to a screen reader. It is back as soon as there is a note, which is when the
          * list is. It stays over "Notebook not found", where it is the only way to start a
          * note without leaving, and the note it makes goes to no notebook (`newNote`).
          */}
        {isMobile && !selection.active && !emptyLibraryInList && (
          <button
            type="button"
            className="fab"
            aria-label="New note"
            disabled={planInactive}
            data-tip={noNewNotes}
            aria-description={noNewNotes}
            onClick={() => void newNote()}
          >
            <PlusIcon />
          </button>
        )}

        {emptyLibraryInList ? (
          /* In place of the list, which has nothing to list: centred in the room under the
             header, without the floating + (see above). `.note-list` is the column's
             scroller and claims its height; this claims the same. */
          <div className="empty-state-slot">
            <EmptyLibrary heading="h3" />
            {offerSampleNotes && <SampleNotes layout="empty" />}
          </div>
        ) : showNotebookMissing ? (
          /* In the list's place, at every width, and instead of "No notes in …": the
             same fact the state already says. Not the workspace pane, which may be
             holding an open note. */
          <div className="empty-state-slot">
            <NotebookMissing notebook={notebook} notebooks={notebooks} whole={libraryWhole} />
          </div>
        ) : tableMode ? (
          <NoteTable
            notes={matchRows ?? notes}
            columns={columns}
            search={{ sort, order, sortField }}
            ranked={searching}
            hints={matchHints}
            tagColor={tagColor}
            notebook={notebook ?? ''}
            total={results?.length ?? total}
            busy={searching ? searchStale : stale}
            hasNextPage={!searching && list.hasNextPage}
            isFetchingNextPage={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            onSort={sortBy}
            onKeyDown={onListKeysWithSelection}
            tableRef={tableRef}
            empty={searching ? searchEmpty : emptyMessage}
            onEdit={onEditCell}
            totals={tableTotals}
            selection={{
              has: selection.has,
              active: selection.active,
              all: selection.active && selection.ids.length === rowIds.length,
              onPick: selection.pick,
              onSelectAll: selection.selectAll,
              onClear: selection.clear,
            }}
          />
        ) : (
        <ul
          className={['note-list', cardsMode && 'cards', selection.active && 'selecting'].filter(Boolean).join(' ')}
          ref={listMotionRef}
          aria-busy={(searching ? searchStale : stale) || undefined}
          aria-multiselectable={results === null || cardsMode ? true : undefined}
          // Arrow keys move in two directions over the cards (`useListKeys`).
          data-grid={cardsMode ? '' : undefined}
          onKeyDown={onListKeysWithSelection}
        >
          {/*
              Tags and notebooks whose names match, before the notes that do. The needle is
              the debounced query so they arrive together with the results rather than a
              beat ahead of them. Picking one clears the query, and on a phone closes the
              field, the same close the back arrow does, minus the clearing it has already
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
          {/* The cards draw the matches as cards, selectable as the table's rows are, and
              the loaded notes the same way when nothing is searched; the list draws the
              matches as results, with the snippet that says why each matched. */}
          {cardsMode &&
            (results !== null && searchEmpty !== null && cardNotes.length === 0 ? (
              <li className="muted small empty">{searchEmpty}</li>
            ) : (
              cardNotes.map((n) => (
                <NoteCard
                  key={n.id}
                  note={n}
                  sort={sort ?? DEFAULT_NOTE_SORT}
                  replacedByNote={isMobile}
                  hint={cardHints.get(n.id)}
                  selection={rowSelection(n.id)}
                />
              ))
            ))}
          {results !== null &&
            !cardsMode &&
            (searchOffline ? (
              <li className="muted small empty">Search needs a connection.</li>
            ) : awaiting ? null : (
              // Nothing until the first answer: "No matches" would be a claim about the
              // notes, and a line that flashes for the length of a fast request is the
              // flicker this is avoiding. The count in the header says it is searching.
              <SearchResults results={results} />
            ))}

          {results === null &&
            !cardsMode &&
            notes.map((n) => (
              <NoteListItem
                key={n.id}
                note={n}
                to="/notes/$noteId"
                sort={sort ?? DEFAULT_NOTE_SORT}
                replacedByNote={isMobile}
                tagColor={tagColor}
                selection={rowSelection(n.id)}
              />
            ))}

          {results === null && list.hasNextPage && (
            <li data-motion-key="more">
              <button
                ref={autoLoad}
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
            <li className="muted small empty" data-motion-key="empty">
              {emptyMessage}
            </li>
          )}
          {offerSampleNotes && (
            <li>
              <SampleNotes layout="empty" />
            </li>
          )}
        </ul>
        )}

        {covered && <SearchCoverage coverage={covered} />}

        {/* Trash is a row of the rail and of the drawer; the column is the list alone.
            `.note-list` takes the leftover height, so the status lands on the floor. */}
        <IndexingStatus />

        {/* Inside the sidebar, so the rule that hides the list under an open note on a
            phone takes the bar with it (see the New button above for the same reason). */}
        {selection.active && (
          <SelectionBar
            count={selection.ids.length}
            total={rowIds.length}
            onClear={selection.clear}
            onSelectAll={selection.selectAll}
          >
            <button
              type="button"
              className="icon-btn"
              aria-label="Move to notebook"
              data-tip="Move to notebook"
              disabled={bulkBusy}
              onClick={() => setBulkSheet('move')}
            >
              <NotebookActionIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Tags"
              data-tip="Tags"
              disabled={bulkBusy}
              onClick={() => setBulkSheet('tags')}
            >
              <TagActionIcon />
            </button>
            {/*
                Export, before Delete so the destructive action stays at the end. The way
                Evernote exports (select, then export) and the one export no filter can
                describe: three notes of five, or notes from different notebooks. The
                selection stays, as it does after Move and Tags, so a second look at what
                was exported is a glance. Waits while another export runs, since one runs
                at a time; the snackbar says how this one goes.
            */}
            <button
              type="button"
              className="icon-btn"
              aria-label={selectionExportLabel}
              data-tip={selectionExportLabel}
              disabled={exportRunning}
              onClick={() => startExport({ ids: selection.ids })}
            >
              <DownloadIcon />
            </button>
            <button
              type="button"
              className="icon-btn danger"
              aria-label="Delete"
              data-tip="Delete"
              disabled={bulkBusy}
              onClick={() => setPendingTrash(true)}
            >
              <TrashIcon />
            </button>
          </SelectionBar>
        )}
      </aside>

      <ResizeHandle
        label="Resize sidebar"
        containerRef={layout.containerRef}
        /**
         * Measured from the grid's left edge, less the channel between the two columns.
         *
         * The handle does not sit at the sidebar's right edge: the grid puts a gap either
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

      {/* The routed workspace hears how many rows the column holds; see `ListRowsContext`. */}
      <ListRowsContext.Provider value={list.isPending || stale ? null : notes.length}>{children}</ListRowsContext.Provider>

      <FreeNotesNotice />
    </div>
  );
}
