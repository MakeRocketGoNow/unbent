package com.makerocketgonow.unbent.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDateRangePickerState
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.NoteSummary
import com.makerocketgonow.unbent.api.Notebook
import com.makerocketgonow.unbent.api.SearchResult
import com.makerocketgonow.unbent.api.Tag
import com.makerocketgonow.unbent.api.UNFILED
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.Shapes
import com.makerocketgonow.unbent.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * How the list is ordered. The same five choices the web offers, with the same labels.
 *
 * Search results are ranked by relevance and ignore this: reordering them by date would
 * discard the ranking that makes them worth showing.
 */
enum class NoteSort(val key: String, val order: String, val label: Int) {
    UPDATED("updated", "desc", R.string.sort_updated),
    NEWEST("created", "desc", R.string.sort_newest),
    OLDEST("created", "asc", R.string.sort_oldest),
    TITLE_AZ("title", "asc", R.string.sort_title_az),
    TITLE_ZA("title", "desc", R.string.sort_title_za);

    /** Whether rows should show the creation date, so the date shown is the one sorted by. */
    val byCreated: Boolean get() = key == "created"
}

/**
 * The note list: search, the notebook and tag filters, sort, and a way to a new note.
 *
 * The filters live in a drawer rather than in the list's header because in an archive
 * this size they are a directory — dozens of notebooks and tags, each with a count — and
 * that is a sidebar's worth of content, which on a phone is what a drawer is. Searching
 * narrows the current filter rather than escaping it, as on the web: with a notebook
 * selected, "insurance" means "insurance in here".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotesScreen(
    /**
     * Owned by the navigation host, not by this screen: a destination is taken out of
     * composition when it navigates away, and state remembered here would be rebuilt empty
     * every time a note was opened and closed.
     */
    state: NotesState,
    listState: LazyListState,
    /** Flipped by another screen that changed a note or notebook, so this one reloads. */
    refreshKey: Boolean = false,
    onRefreshed: () -> Unit = {},
    onOpen: (String) -> Unit,
    onOpenNew: (String) -> Unit,
    onSettings: () -> Unit,
    onManageNotebooks: (creating: Boolean) -> Unit,
    onTrash: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var filtering by rememberSaveable { mutableStateOf(false) }
    var pickingSort by rememberSaveable { mutableStateOf(false) }

    /*
     * The list follows its filter and sort.
     *
     * Keyed on the filter rather than on entering the screen, which matters now that the
     * state outlives this composable: returning from a note re-enters here with the same
     * filter, and a key that included composition would refetch the whole list every time
     * — which is the reset this state was hoisted to avoid. `loaded` covers the very first
     * run, when there is nothing on screen yet.
     */
    LaunchedEffect(state.notebook, state.selectedTags, state.sort, state.from, state.to) {
        if (!state.loaded || state.filterChanged) state.load()
    }
    LaunchedEffect(state) { if (state.notebooks.isEmpty() && state.tags.isEmpty()) state.loadFilters() }

    // Coming back from a note, the notebooks screen or the trash — any of which may have
    // changed a row on this list, the directory counts, or both.
    LaunchedEffect(refreshKey) {
        if (refreshKey) {
            state.refreshInPlace()
            onRefreshed()
        }
    }

    /*
     * Reload whenever the app comes back to the front.
     *
     * A share from another app lands a note while this activity sits in the background,
     * and a list that only loaded once would show the library as it was before. In place,
     * so returning to the app keeps the reader's position the same way returning from a
     * note does. The lifecycle brings a new observer up to the current state, so
     * registering fires ON_RESUME at once; that first one is skipped, since the list has
     * not loaded yet and `refreshInPlace` has nothing to rebuild.
     */
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, state) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && state.loaded) {
                scope.launch { state.refreshInPlace() }
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    if (state.unauthorized) LaunchedEffect(Unit) { onUnauthorized() }

    // Debounced, so the query reaches the server once per pause rather than per keystroke.
    LaunchedEffect(state.query) {
        delay(300)
        state.search()
    }

    // Back closes what is open before it leaves the app: the drawer, then the search.
    // The drawer does not do this for itself, and a back press that quit the app with a
    // drawer still open is the kind of thing that makes an app feel like a web page.
    BackHandler(enabled = filtering) { filtering = false }
    BackHandler(enabled = drawer.isOpen && !filtering) { scope.launch { drawer.close() } }
    BackHandler(enabled = searchOpen && !drawer.isOpen) {
        searchOpen = false
        state.changeQuery("")
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                FilterDrawer(
                    state = state,
                    onPicked = { scope.launch { drawer.close() } },
                    onManageNotebooks = onManageNotebooks,
                    onTrash = onTrash,
                    onSettings = onSettings,
                )
            }
        },
    ) {
        Scaffold(
            topBar = {
                if (searchOpen) {
                    SearchBar(
                        query = state.query,
                        onQuery = state::changeQuery,
                        onClose = {
                            searchOpen = false
                            state.changeQuery("")
                        },
                    )
                } else {
                    TopAppBar(
                        title = { ListTitle(state) },
                        navigationIcon = {
                            IconButton(onClick = { scope.launch { drawer.open() } }) {
                                Icon(Icons.Default.Menu, contentDescription = stringResource(R.string.filters))
                            }
                        },
                        actions = {
                            IconButton(onClick = { searchOpen = true }) {
                                Icon(Icons.Default.Search, contentDescription = stringResource(R.string.search))
                            }
                            /*
                             * Filtering earns an icon of its own rather than a place in the
                             * overflow: it is the thing this screen is for, and a menu is a
                             * poor home for something reached this often. The badge says a
                             * filter is on without naming it — the title does the naming —
                             * so a narrowed list is never mistaken for the whole archive.
                             */
                            IconButton(onClick = { filtering = true }) {
                                BadgedBox(
                                    badge = { if (state.filtered) Badge() },
                                ) {
                                    Icon(
                                        painterResource(R.drawable.ic_filter),
                                        contentDescription = stringResource(R.string.filter_notes),
                                    )
                                }
                            }
                            /*
                             * Sort, as itself.
                             *
                             * This corner was a ⋮ holding "Sort: …" and Settings. The gear
                             * had given up its own icon because it is a rare destination,
                             * and Settings then had nowhere to be but a menu — so sort,
                             * reached several times a day, paid for it with an extra tap.
                             * Settings is a row on the drawer's floor now, as Keep draws
                             * it and as the web app does, which gives this corner back to
                             * the control it should always have been. The description
                             * names the current order, since an order you cannot see is a
                             * list arranged in a way you did not ask for; the dialog marks
                             * it the moment it opens.
                             */
                            IconButton(onClick = { pickingSort = true }) {
                                Icon(
                                    painterResource(R.drawable.ic_sort),
                                    contentDescription = stringResource(
                                        R.string.sort_current,
                                        stringResource(state.sort.label),
                                    ),
                                )
                            }
                        },
                    )
                }
            },
            floatingActionButton = {
                FloatingActionButton(
                    onClick = {
                        scope.launch { state.create()?.let(onOpenNew) }
                    },
                ) {
                    Icon(Icons.Default.Add, contentDescription = stringResource(R.string.new_note))
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                /*
                 * Above the list rather than in place of it: the notes shown are real, and
                 * the only thing wrong is that there are more of them than the filter on
                 * screen implies. Replacing the list with this would hide the results the
                 * fallback just went to the trouble of fetching.
                 */
                state.droppedTags.takeIf { it.isNotEmpty() }?.let { dropped ->
                    Text(
                        pluralStringResource(
                            R.plurals.tags_dropped,
                            dropped.size,
                            state.selectedTags.firstOrNull().orEmpty(),
                            dropped.joinToString(", ") { "#$it" },
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Space.Large, vertical = Space.Small),
                    )
                    HorizontalDivider()
                }

                PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = { scope.launch { state.refresh(pulled = true) } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                val results = state.results
                val error = state.error
                when {
                    results != null -> SearchList(results, onOpen)

                    error != null && state.items.isEmpty() -> Column(
                        Modifier.fillMaxSize().padding(Space.Screen),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(stringResource(R.string.load_failed, error), color = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.height(Space.Medium))
                        OutlinedButton(onClick = { scope.launch { state.load() } }) {
                            Text(stringResource(R.string.retry))
                        }
                    }

                    state.loaded && state.items.isEmpty() -> Box(
                        Modifier.fillMaxSize().padding(Space.Screen),
                        contentAlignment = Alignment.TopCenter,
                    ) {
                        Text(
                            stringResource(if (state.filtered) R.string.no_notes_filtered else R.string.no_notes),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    !state.loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }

                    else -> NoteList(
                        listState = listState,
                        items = state.items,
                        sort = state.sort,
                        showNotebook = state.notebook == null,
                        loadingMore = state.loading,
                        onOpen = onOpen,
                        onNearEnd = { scope.launch { state.loadMore() } },
                    )
                }
            }
            }
        }
    }

    if (filtering) FilterSheet(state = state, onDismiss = { filtering = false })
    if (pickingSort) SortDialog(state = state, onDismiss = { pickingSort = false })
}

/**
 * What the list is showing and how much of it: everything, a notebook, some tags, or tags
 * within a notebook — the filters combine, as on the web, so the title names them all. A
 * date range goes on the second line beside the count, so a range is never applied
 * invisibly: it is there even while the count is still on its way after a reload.
 *
 * Every selected tag is named rather than the first plus a count. Two tags ANDed are a
 * different question from either alone, and a title reading "#Receipt +1" would not say
 * which question is on screen. The line ellipsises when it must, which is the honest
 * failure — the row of chips in the filter surface is where a long selection is read.
 */
@Composable
private fun ListTitle(state: NotesState) {
    val notebook = state.notebook
    val parts = listOfNotNull(
        when (notebook) {
            null -> null
            UNFILED -> stringResource(R.string.inbox)
            else -> notebook
        },
        state.selectedTags.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" },
    )
    val title = if (parts.isEmpty()) stringResource(R.string.app_name) else parts.joinToString(" · ")
    val detail = listOfNotNull(
        state.total?.let { pluralStringResource(R.plurals.notes_count, it, it) },
        rangeLabel(state.from, state.to),
    ).joinToString(" · ")
    Column {
        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (detail.isNotEmpty()) {
            Text(
                detail,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** The range as a phrase, or null when there is none. One end alone is a phrase too. */
@Composable
internal fun rangeLabel(from: String?, to: String?): String? = when {
    from != null && to != null -> stringResource(R.string.date_range, formatDay(from), formatDay(to))
    from != null -> stringResource(R.string.date_from, formatDay(from))
    to != null -> stringResource(R.string.date_to, formatDay(to))
    else -> null
}

/** The app bar, turned into a search field. Back closes it and clears the query. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchBar(query: String, onQuery: (String) -> Unit, onClose: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onClose) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.close_search))
            }
        },
        title = {
            val style = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface)
            BasicTextField(
                value = query,
                onValueChange = onQuery,
                singleLine = true,
                textStyle = style,
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = {}),
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                decorationBox = { inner ->
                    Box {
                        if (query.isEmpty()) {
                            Text(
                                stringResource(R.string.search_hint),
                                style = style,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        inner()
                    }
                },
            )
        },
        actions = {
            if (query.isNotEmpty()) {
                IconButton(onClick = { onQuery("") }) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.clear))
                }
            }
        },
    )
}

/**
 * The directory: where to go. Every notebook with its count, and the Inbox.
 *
 * Drawn the way Keep draws its drawer, which the web app now copies too: a glyph on every
 * row, because a column of bare words is scanned by reading and a column with a picture
 * beside each word is scanned by looking; the notebooks under a section head that carries
 * the way to edit them; and the way to make another as the last row of the list it adds
 * to. The glyphs are the web's own lucide shapes, traced (`ic_notes`, `ic_inbox`,
 * `ic_notebook`), so someone who learned the drawer on the site finds the same pictures
 * here.
 *
 * It used to hold the sort and the date range as well, which made it three unrelated
 * things stacked in one column — a place to go, a filter to combine, and a view setting —
 * and the user had to re-orient twice on the way down. Those moved to the app bar's
 * overflow, where a setting you change occasionally belongs. What is left answers one
 * question, so it reads as a directory instead of a control panel.
 *
 * Counts are the point. In an archive of thirteen thousand notes, "Dentist 22" is the
 * information; a bare name would leave the user to open it and find out.
 *
 * Tags have left entirely, to the filter sheet where the rest of the narrowing lives.
 * They were never the same kind of thing as a notebook: a notebook is a place a note is
 * kept and the drawer is how you go there, while a tag is a condition applied to whatever
 * is already on screen. Keeping both here meant the notebooks — the reason to open this —
 * shared a column with a filter that combines with them.
 */
@Composable
private fun FilterDrawer(
    state: NotesState,
    onPicked: () -> Unit,
    /** True when the user asked to create, so the new-notebook field takes focus. */
    onManageNotebooks: (creating: Boolean) -> Unit,
    onTrash: () -> Unit,
    onSettings: () -> Unit,
) {
    // The list scrolls; the footer does not. A create action that scrolled away with the
    // notebooks would be unreachable exactly when the list is long enough to need it.
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(vertical = Space.Medium),
        ) {
            Text(
                stringResource(R.string.app_name),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = Space.Screen, vertical = Space.Small),
            )

            val item = Modifier.padding(horizontal = Space.Medium)
            NavigationDrawerItem(
                label = { Text(stringResource(R.string.all_notes)) },
                icon = { Icon(painterResource(R.drawable.ic_notes), contentDescription = null) },
                selected = state.notebook == null && state.selectedTags.isEmpty(),
                shape = Shapes.Row,
                onClick = {
                    state.filterBy(notebook = null, tags = emptyList())
                    onPicked()
                },
                modifier = item,
            )
            // Shown while it has anything in it, or while it is what is selected: an empty Inbox
            // that vanished from under the selection would leave the title pointing at nothing.
            if (state.unfiled > 0 || state.notebook == UNFILED) {
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.inbox)) },
                    icon = { Icon(painterResource(R.drawable.ic_inbox), contentDescription = null) },
                    badge = { CountBadge(state.unfiled) },
                    selected = state.notebook == UNFILED,
                    shape = Shapes.Row,
                    onClick = {
                        state.filterBy(notebook = UNFILED, tags = emptyList())
                        onPicked()
                    },
                    modifier = item,
                )
            }

            HorizontalDivider(Modifier.padding(vertical = Space.Medium))

            /*
             * The section's name, and the way to change what is in it.
             *
             * A muted word on the left and Edit on the right, as Keep heads its labels.
             * The rows below are places to go, so anything that changes them has to live
             * outside the rows — a control on every line of the app's main navigation
             * would put a rarely used thing on its most used surface. Edit replaces the
             * gear that used to sit in the footer, which was the same destination behind
             * a picture that said "settings". Shown even with no notebooks, because the
             * way to make the first one is the row at the end of this section.
             */
            Row(
                Modifier
                    .fillMaxWidth()
                    // The rows' own inset plus their inner padding, so the word sits over
                    // the glyphs rather than over the pill's rounded edge.
                    .padding(start = Space.Medium + Space.Large, end = Space.Medium),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.notebooks_label),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { onManageNotebooks(false) }) {
                    Text(stringResource(R.string.notebooks_edit))
                }
            }

            for (nb in state.notebooks) {
                NavigationDrawerItem(
                    label = { Text(nb.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    icon = { Icon(painterResource(R.drawable.ic_notebook), contentDescription = null) },
                    badge = { CountBadge(nb.count) },
                    selected = state.notebook == nb.name,
                    shape = Shapes.Row,
                    onClick = {
                        state.filterBy(notebook = nb.name, tags = emptyList())
                        onPicked()
                    },
                    modifier = item,
                )
            }

            /*
             * Making another notebook, as the last row of the notebooks rather than a
             * fixed footer: it is about the list above it, and Keep ends its labels the
             * same way. It was fixed so it stayed one tap from anywhere in a long
             * directory; that reachability now belongs to Edit in the section head, at
             * the top, where a long list starts.
             *
             * It opens the same screen Edit does, because creating a notebook and tidying
             * the list are the same errand often enough that two destinations would be a
             * distinction without a difference. It asks for the field to be focused on
             * arrival, so the row keeps its promise: it says create, and the keyboard is
             * up with the cursor waiting.
             */
            NavigationDrawerItem(
                label = { Text(stringResource(R.string.new_notebook)) },
                icon = { Icon(Icons.Default.Add, contentDescription = null) },
                selected = false,
                shape = Shapes.Row,
                onClick = { onManageNotebooks(true) },
                modifier = item,
            )
        }

        /*
         * The floor: the two destinations that are not places notes live.
         *
         * The trash sits here rather than among the notebooks: it is a place to go, but it
         * is not part of the library — putting it in the list would make it look like
         * somewhere notes are filed. Settings joins it from the app bar's overflow, where
         * it had been the one item that was not about the list on screen. Keep ends its
         * drawer the same way, Trash then Settings as plain rows, and the web app now does
         * too; a thumb that has opened the ☰ is already where both of these are.
         *
         * Sign out is deliberately not a third row. It is rare and disruptive, and it
         * stays on the Settings screen under the account it signs out of — one tap further
         * than a row here, which is the right distance for it.
         */
        HorizontalDivider()
        NavigationDrawerItem(
            label = { Text(stringResource(R.string.trash)) },
            icon = { Icon(Icons.Default.Delete, contentDescription = null) },
            selected = false,
            shape = Shapes.Row,
            onClick = onTrash,
            modifier = Modifier.padding(horizontal = Space.Medium, vertical = Space.Hair),
        )
        NavigationDrawerItem(
            label = { Text(stringResource(R.string.settings_title)) },
            icon = { Icon(Icons.Default.Settings, contentDescription = null) },
            selected = false,
            shape = Shapes.Row,
            onClick = onSettings,
            modifier = Modifier.padding(horizontal = Space.Medium, vertical = Space.Hair),
        )
    }
}

/**
 * The sort, as a dialog off the app bar's sort icon.
 *
 * A menu would have worked and would have been worse: the options are longer than a menu
 * row wants to be, and the current one has to be legible at a glance, which a menu shows
 * only after a second tap.
 */
@Composable
private fun SortDialog(state: NotesState, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sort_label)) },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
        text = {
            Column {
                for (sort in NoteSort.entries) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(Shapes.Row)
                            .clickable {
                                state.sortBy(sort)
                                onDismiss()
                            }
                            .padding(horizontal = Space.Small, vertical = Space.Hair),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = state.sort == sort, onClick = null)
                        Text(stringResource(sort.label), modifier = Modifier.padding(start = Space.Small))
                    }
                }
            }
        },
    )
}

/**
 * Material's range picker in a dialog, applied on confirm.
 *
 * A start is required and an end is optional, which is the picker's own grammar: it
 * cannot express a range with only an end, so "until" alone is one thing the web's two
 * fields can say that this cannot. The conversions go through UTC — see DateRange.kt.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DateRangeDialog(
    from: String?,
    to: String?,
    onDismiss: () -> Unit,
    onPick: (from: String, to: String?) -> Unit,
) {
    val picker = rememberDateRangePickerState(
        initialSelectedStartDateMillis = from?.let(::dayMillis),
        initialSelectedEndDateMillis = to?.let(::dayMillis),
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                enabled = picker.selectedStartDateMillis != null,
                onClick = {
                    val start = picker.selectedStartDateMillis ?: return@TextButton
                    onPick(utcDay(start), picker.selectedEndDateMillis?.let(::utcDay))
                },
            ) {
                Text(stringResource(R.string.dates_apply))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
    ) {
        // The weight is what keeps Apply and Cancel on screen on a phone: the range picker
        // is taller than the dialog, and without it pushes its own buttons off the bottom.
        DateRangePicker(state = picker, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun NoteList(
    listState: LazyListState,
    items: List<NoteSummary>,
    sort: NoteSort,
    showNotebook: Boolean,
    loadingMore: Boolean,
    onOpen: (String) -> Unit,
    onNearEnd: () -> Unit,
) {
    // Ask for the next page a few rows before the end, so scrolling never hits a wall.
    LaunchedEffect(listState, items.size) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (last >= items.size - 5) onNearEnd() }
    }

    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
        itemsIndexed(items, key = { _, note -> note.id }) { index, note ->
            NoteRow(note, sort, showNotebook, onClick = { onOpen(note.id) })
            if (index < items.lastIndex) HorizontalDivider()
        }
        if (loadingMore) {
            item {
                Box(Modifier.fillMaxWidth().padding(Space.Large), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
        // Room under the last row for the button that floats over the list.
        item { Spacer(Modifier.height(Space.FabClearance)) }
    }
}

/**
 * One note, as the web's sidebar draws it: title, when, a line of it, its tags.
 *
 * The date follows the sort — ordered by creation, the row shows when the note was
 * created — because "last edited" under a list ordered by creation invites reading the
 * order as wrong, and for an imported archive the two are often years apart. The
 * notebook is shown only while the list spans notebooks; inside one it is the title.
 */
@Composable
private fun NoteRow(note: NoteSummary, sort: NoteSort, showNotebook: Boolean, onClick: () -> Unit) {
    val whenText = formatWhen(if (sort.byCreated) note.createdAt else note.updatedAt)
    val meta = if (showNotebook) "${note.notebook ?: stringResource(R.string.inbox)} · $whenText" else whenText
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = {
            Text(note.title.ifBlank { stringResource(R.string.untitled) }, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        overlineContent = { Text(meta, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Column {
                note.excerpt?.takeIf { it.isNotBlank() }?.let { excerpt ->
                    Text(excerpt, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                if (note.tags.isNotEmpty()) {
                    Text(
                        note.tags.joinToString(" ") { "#$it" },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
        },
    )
}

/**
 * Search hits: the title, which file matched when it was a file, and the snippet with the
 * server's `<<`/`>>` markers turned into highlights. Markers rather than HTML because the
 * body is user content; the same reason the web never interpolates a snippet as markup.
 */
@Composable
private fun SearchList(results: List<SearchResult>, onOpen: (String) -> Unit) {
    if (results.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(Space.Screen), contentAlignment = Alignment.TopCenter) {
            Text(stringResource(R.string.no_matches), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    val highlight = SpanStyle(background = MaterialTheme.colorScheme.primaryContainer)
    LazyColumn(Modifier.fillMaxSize()) {
        itemsIndexed(results, key = { _, r -> r.id }) { index, r ->
            ListItem(
                modifier = Modifier.clickable { onOpen(r.id) },
                headlineContent = {
                    Text(r.title.ifBlank { stringResource(R.string.untitled) }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                overlineContent = r.matchedFile?.let { file ->
                    { Text(stringResource(R.string.matched_in, file), maxLines = 1, overflow = TextOverflow.Ellipsis) }
                },
                supportingContent = {
                    Text(
                        buildAnnotatedString {
                            for (part in r.snippet.split(Regex("(?<=>>)|(?=<<)"))) {
                                if (part.startsWith("<<") && part.endsWith(">>")) {
                                    withStyle(highlight) { append(part.removeSurrounding("<<", ">>")) }
                                } else {
                                    append(part)
                                }
                            }
                        },
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
            )
            if (index < results.lastIndex) HorizontalDivider()
        }
        item { Spacer(Modifier.height(Space.FabClearance)) }
    }
}

/** The list's data: the current filter and sort, the pages fetched under them, the search. */
class NotesState(private val api: UnbentApi) {
    private companion object {
        /** The page the API returns by default, and what [refreshInPlace] counts in. */
        const val PAGE_SIZE = 50
    }

    /**
     * What survives the process being killed while the app sits in the background.
     *
     * Only the filter: which notebook, which tags, which dates, which sort. Everything
     * else this class holds is either fetched data or the status of a request, and both
     * are better re-derived than restored — a page cached an hour ago is worse than a
     * fresh one, and the load effect refetches from the filter anyway. What cannot be
     * re-derived is what the user chose, which is precisely this list.
     *
     * The search query is deliberately absent. Coming back to the app still filtered to a
     * notebook is what anyone would expect; coming back to a half-typed search, with the
     * results it produced, is a state nobody asked to return to.
     *
     * The scroll position is absent for a different reason: `LazyListState` can save its
     * index, but the list comes back empty and pages in fifty at a time, so an index deep
     * in the archive has nothing to anchor to until several pages have loaded. Restoring
     * the filter and starting at the top is the honest outcome.
     *
     * The sort is stored by `name` rather than ordinal, so reordering the enum cannot
     * silently turn someone's "Oldest first" into something else.
     */
    class Saved(
        val notebook: String?,
        val tags: List<String>,
        val sort: String,
        val from: String?,
        val to: String?,
    )

    var items by mutableStateOf<List<NoteSummary>>(emptyList())
        private set
    var total by mutableStateOf<Int?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var unauthorized by mutableStateOf(false)
        private set

    var notebook by mutableStateOf<String?>(null)
        private set
    /**
     * The tags the list is narrowed to, ANDed: a note must carry all of them.
     *
     * A list rather than one tag because that is the question an archive with hundreds of
     * them invites — "receipts that are also medical". Empty means unfiltered; `tags`
     * below is the vocabulary to choose from, which is a different thing entirely.
     */
    var selectedTags by mutableStateOf<List<String>>(emptyList())
        private set
    var sort by mutableStateOf(NoteSort.UPDATED)
        private set
    /** Inclusive `YYYY-MM-DD` bounds, or null for open; see DateRange.kt. */
    var from by mutableStateOf<String?>(null)
        private set
    var to by mutableStateOf<String?>(null)
        private set
    val filtered: Boolean get() =
        notebook != null || selectedTags.isNotEmpty() || from != null || to != null

    var notebooks by mutableStateOf<List<Notebook>>(emptyList())
        private set
    var unfiled by mutableStateOf(0)
        private set
    var tags by mutableStateOf<List<Tag>>(emptyList())
        private set

    var query by mutableStateOf("")
        private set

    /** Null while not searching; empty when a search found nothing. */
    var results by mutableStateOf<List<SearchResult>?>(null)
        private set

    private var cursor: String? = null
    /** Which load is current, so a page from a superseded filter is thrown away. */
    private var generation = 0

    /** Puts a saved filter back, before the first load runs. */
    fun restore(saved: Saved) {
        notebook = saved.notebook
        selectedTags = saved.tags
        sort = NoteSort.entries.firstOrNull { it.name == saved.sort } ?: NoteSort.UPDATED
        from = saved.from
        to = saved.to
    }

    /** The filter as it stands, for [Saved]. */
    fun save(): Saved = Saved(notebook, selectedTags, sort.name, from, to)

    suspend fun load() = fetch(reset = true)

    suspend fun loadMore() {
        if (cursor != null && !loading && results == null) fetch(reset = false)
    }

    /** The list and the directory together; what a pull, or coming back to the app, asks for. */
    suspend fun refresh(pulled: Boolean = false) {
        if (pulled) refreshing = true
        try {
            loadFilters()
            fetch(reset = true)
            if (results != null) search()
        } finally {
            refreshing = false
        }
    }

    /**
     * Brings the rows up to date without giving up the reader's place.
     *
     * [refresh] restarts from the first page, which is right for a pull — the gesture means
     * "start again" — and wrong for coming back from a note, where the list is meant to be
     * as it was left. Deep in an unfiltered archive that would drop the pages already read
     * and snap to the top, which is most of what this whole change set out to stop.
     *
     * So: re-request exactly as many pages as are loaded, and swap them in at the end. The
     * rows are a data class, so pages that did not change compare equal and Compose repaints
     * nothing; the note that was edited is the only row that moves. Most lists here are one
     * page — filter to almost any tag in a real archive and everything fits — so this is
     * usually a single request.
     *
     * The count and the directory come along, because an edit can move a note between
     * notebooks and change what the drawer should say.
     */
    suspend fun refreshInPlace() {
        if (!loaded) return
        val pages = maxOf(1, (items.size + PAGE_SIZE - 1) / PAGE_SIZE)
        val mine = ++generation

        loadFilters()
        if (mine != generation) return

        val rebuilt = mutableListOf<NoteSummary>()
        var next: String? = null
        for (page in 0 until pages) {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    api.listNotes(
                        cursor = next,
                        notebook = notebook,
                        tags = selectedTags,
                        sort = sort.key,
                        order = sort.order,
                        from = from,
                        to = to,
                    )
                }
            }
            // A failure mid-way leaves the list exactly as it was rather than half rebuilt:
            // stale rows are better than a list that has lost its second half.
            val fetched = result.getOrNull() ?: return
            if (mine != generation) return
            rebuilt += fetched.items
            if (page == 0 && fetched.total != null) total = fetched.total
            next = fetched.cursor ?: break
        }

        items = rebuilt
        cursor = next
        if (results != null) search()
    }

    /** Changes what the list shows. The screen reloads when it sees the change. */
    fun filterBy(notebook: String?, tags: List<String>) {
        if (this.notebook == notebook && this.selectedTags == tags) return
        droppedTags = emptyList()
        this.notebook = notebook
        this.selectedTags = tags
        clearForReload()
    }

    /**
     * Tags this server could not filter by, so the screen can say what it dropped.
     *
     * Cleared by the next deliberate filter change: the notice belongs to one refusal, not
     * to the session, and a banner that outlived the filter it described would be a puzzle.
     */
    var droppedTags by mutableStateOf<List<String>>(emptyList())
        private set

    /** Takes every filter off at once, leaving the sort alone — it is not a filter. */
    fun clearFilters() {
        if (!filtered) return
        notebook = null
        selectedTags = emptyList()
        from = null
        to = null
        clearForReload()
    }

    /**
     * Adds or removes one tag, leaving the rest of the filter alone.
     *
     * The picker works a tag at a time — tapping one that is on turns it off — and doing
     * that through [filterBy] would make every call site rebuild the list itself.
     */
    fun toggleTag(tag: String) {
        filterBy(notebook, if (tag in selectedTags) selectedTags - tag else selectedTags + tag)
    }

    fun sortBy(sort: NoteSort) {
        if (this.sort == sort) return
        this.sort = sort
        clearForReload()
    }

    /**
     * Narrows the list to a range of days on the date the sort shows. Untouched by
     * [filterBy], as on the web: which notebook and which year are separate questions,
     * and answering one should not forget the other.
     */
    fun dateRange(from: String?, to: String?) {
        if (this.from == from && this.to == to) return
        this.from = from
        this.to = to
        clearForReload()
    }

    /**
     * True when the filter has moved since the last load.
     *
     * The screen's load effect is keyed on the filter fields, but a Compose key also fires
     * when the composable is re-entered — which now happens on every return from a note,
     * with the filter untouched. This is how the effect tells "the user changed something"
     * from "we are back on this screen", so returning keeps the list it left.
     */
    var filterChanged by mutableStateOf(false)
        private set

    private fun clearForReload() {
        filterChanged = true
        loaded = false
        items = emptyList()
        // The count belongs to the old filter; showing it under the new title would lie
        // for as long as the first page takes.
        total = null
    }

    fun changeQuery(q: String) {
        query = q
        if (q.isBlank()) results = null
    }

    /** Runs the current query against the current filter. A blank query is no search at all. */
    suspend fun search() {
        val q = query.trim()
        if (q.isEmpty()) {
            results = null
            return
        }
        val result = withContext(Dispatchers.IO) { runCatching { api.search(q, notebook, selectedTags, from, to) } }
        // Only if the box still says what was searched for; a stale answer is worse than none.
        if (query.trim() != q) return
        result.onSuccess { results = it }.onFailure { e ->
            if ((e as? ApiException)?.status == 401) unauthorized = true else error = e.message
        }
    }

    /** A new, empty note, to be opened at once. Null when it could not be made. */
    suspend fun create(): String? {
        val result = withContext(Dispatchers.IO) { runCatching { api.createNote("") } }
        return result.onFailure { e ->
            if ((e as? ApiException)?.status == 401) unauthorized = true else error = e.message
        }.getOrNull()?.id
    }

    suspend fun loadFilters() {
        withContext(Dispatchers.IO) { runCatching { api.listNotebooks() } }.onSuccess {
            notebooks = it.notebooks
            unfiled = it.unfiled

            /*
             * A filter pointing at a notebook that no longer exists shows an empty list and
             * says nothing about why. That happens for real now that notebooks can be
             * deleted from inside the app: delete the one you are reading and the title
             * still names it over nothing. Fall back to everything, which is the honest
             * answer — the notes are not gone, only unfiled.
             *
             * The Inbox is exempt: it is not in this list and never was.
             */
            val current = notebook
            if (current != null && current != UNFILED && it.notebooks.none { nb -> nb.name == current }) {
                notebook = null
                clearForReload()
            }
        }
        withContext(Dispatchers.IO) { runCatching { api.listTags() } }.onSuccess { fresh ->
            tags = fresh
            // Same for tags: trashing a notebook's notes can take the last note off a tag,
            // and a filter on a tag the account no longer has cannot be turned off from
            // the picker, because the picker no longer lists it.
            val gone = selectedTags.filter { sel -> fresh.none { it.name == sel } }
            if (gone.isNotEmpty()) {
                selectedTags = selectedTags - gone.toSet()
                clearForReload()
            }
        }
    }

    private suspend fun fetch(reset: Boolean) {
        val mine = ++generation
        loading = true
        error = null
        val result = withContext(Dispatchers.IO) {
            runCatching {
                api.listNotes(
                    cursor = if (reset) null else cursor,
                    notebook = notebook,
                    tags = selectedTags,
                    sort = sort.key,
                    order = sort.order,
                    from = from,
                    to = to,
                )
            }
        }
        if (mine != generation) return
        loading = false
        result.onSuccess { page ->
            items = if (reset) page.items else items + page.items
            cursor = page.cursor
            if (page.total != null) total = page.total
            loaded = true
            if (reset) filterChanged = false
        }.onFailure { e ->
            val status = (e as? ApiException)?.status
            when {
                status == 401 -> unauthorized = true

                /*
                 * A 400 while sending several tags means this app is talking to a server
                 * that predates the multi-tag filter: it reads `tag` as one value, gets a
                 * list, and refuses the whole request.
                 *
                 * Worth handling rather than reporting, because the phone updates on its
                 * own schedule and the server on someone else's — a self-hoster who has not
                 * redeployed, or simply an app that reached the store first. The failure
                 * was total and unexplained: the list went blank, the title still named
                 * both tags, and "List notes failed: 400" gave no hint that dropping one
                 * would fix it.
                 *
                 * Falling back to the first tag rather than none: one tag is what the old
                 * server understands, and it is the narrowing the user asked for minus the
                 * part it cannot do. Saying so matters as much as doing it — a filter that
                 * silently means something other than what the chips show is worse than an
                 * error.
                 */
                status == 400 && selectedTags.size > 1 -> {
                    val kept = selectedTags.first()
                    droppedTags = selectedTags.drop(1)
                    selectedTags = listOf(kept)
                    clearForReload()
                }

                else -> error = e.message ?: e.javaClass.simpleName
            }
        }
    }
}
