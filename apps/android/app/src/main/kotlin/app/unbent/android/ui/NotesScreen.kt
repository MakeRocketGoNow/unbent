package app.unbent.android.ui

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.platform.LocalLifecycleOwner
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
import app.unbent.android.R
import app.unbent.android.api.ApiException
import app.unbent.android.api.NoteSummary
import app.unbent.android.api.Notebook
import app.unbent.android.api.SearchResult
import app.unbent.android.api.Tag
import app.unbent.android.api.UNFILED
import app.unbent.android.api.UnbentApi
import app.unbent.android.ui.theme.Shapes
import app.unbent.android.ui.theme.Space
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
    api: UnbentApi,
    onOpen: (String) -> Unit,
    onOpenNew: (String) -> Unit,
    onSettings: () -> Unit,
    onManageNotebooks: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val state = remember(api) { NotesState(api) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var overflowOpen by remember { mutableStateOf(false) }
    var pickingTags by rememberSaveable { mutableStateOf(false) }
    var pickingSort by rememberSaveable { mutableStateOf(false) }
    var pickingDates by rememberSaveable { mutableStateOf(false) }

    // The list follows its filter and sort: the first load, and a reload on every change.
    // The directory the drawer shows is loaded once here and refreshed with the list.
    LaunchedEffect(state.notebook, state.tag, state.sort, state.from, state.to) { state.load() }
    LaunchedEffect(state) { state.loadFilters() }

    /*
     * Reload whenever the screen comes back to the front.
     *
     * Coming back from a note re-enters this composable fresh, so that case takes care of
     * itself. Coming back to the app does not: a share from another app lands a note
     * while this activity sits in the background, and a list that only loaded once would
     * show the library as it was before. The lifecycle brings a new observer up to the
     * current state, so registering fires ON_RESUME at once; that first one is skipped,
     * since the effect above is already loading.
     */
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, state) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && state.loaded) scope.launch { state.refresh() }
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
    BackHandler(enabled = pickingTags) { pickingTags = false }
    BackHandler(enabled = drawer.isOpen && !pickingTags) { scope.launch { drawer.close() } }
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
                    onPickTag = { pickingTags = true },
                    onManageNotebooks = onManageNotebooks,
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
                             * The gear gave up its place here to the overflow. Settings is
                             * a rare destination, and an icon of its own next to sort and
                             * dates implied the three were the same kind of thing.
                             */
                            IconButton(onClick = { overflowOpen = true }) {
                                Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.more))
                            }
                            NotesOverflow(
                                state = state,
                                expanded = overflowOpen,
                                onDismiss = { overflowOpen = false },
                                onSort = { pickingSort = true },
                                onDates = { pickingDates = true },
                                onSettings = onSettings,
                            )
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
            PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = { scope.launch { state.refresh(pulled = true) } },
                modifier = Modifier.padding(padding).fillMaxSize(),
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

    if (pickingTags) {
        TagSheet(
            state = state,
            onDismiss = { pickingTags = false },
            onPicked = {
                pickingTags = false
                scope.launch { drawer.close() }
            },
        )
    }
    if (pickingSort) SortDialog(state = state, onDismiss = { pickingSort = false })
    if (pickingDates) {
        DateRangeDialog(
            from = state.from,
            to = state.to,
            onDismiss = { pickingDates = false },
            onPick = { from, to ->
                pickingDates = false
                state.dateRange(from, to)
            },
        )
    }
}

/**
 * What the list is showing and how much of it: everything, a notebook, a tag, or a tag
 * within a notebook — the filters combine, as on the web, so the title names both. A date
 * range goes on the second line beside the count, so a range is never applied invisibly:
 * it is there even while the count is still on its way after a reload.
 */
@Composable
private fun ListTitle(state: NotesState) {
    val notebook = state.notebook
    val tag = state.tag
    val parts = listOfNotNull(
        when (notebook) {
            null -> null
            UNFILED -> stringResource(R.string.inbox)
            else -> notebook
        },
        tag?.let { "#$it" },
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
private fun rangeLabel(from: String?, to: String?): String? = when {
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
 * The directory: where to go. Every notebook with its count, the Inbox, and a way into
 * the tags.
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
 * Tags are one row rather than the chip cloud they were, because tags are a second axis
 * that combines with the notebook — picking one keeps the notebook selected — and a cloud
 * of forty chips in the middle of the notebook list buried the notebooks under a filter
 * that is not even the same kind of thing. The row names the active tag so the filter is
 * never applied invisibly.
 */
@Composable
private fun FilterDrawer(
    state: NotesState,
    onPicked: () -> Unit,
    onPickTag: () -> Unit,
    onManageNotebooks: () -> Unit,
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
                selected = state.notebook == null && state.tag == null,
                shape = Shapes.Row,
                onClick = {
                    state.filterBy(notebook = null, tag = null)
                    onPicked()
                },
                modifier = item,
            )
            // Shown while it has anything in it, or while it is what is selected: an empty Inbox
            // that vanished from under the selection would leave the title pointing at nothing.
            if (state.unfiled > 0 || state.notebook == UNFILED) {
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.inbox)) },
                    badge = { CountBadge(state.unfiled) },
                    selected = state.notebook == UNFILED,
                    shape = Shapes.Row,
                    onClick = {
                        state.filterBy(notebook = UNFILED, tag = null)
                        onPicked()
                    },
                    modifier = item,
                )
            }

            /*
             * Above the divider with All notes and the Inbox, not down among the notebooks:
             * those three are ways of choosing what to look at, and the notebooks below are
             * the library itself. The chevron says it opens something rather than filtering
             * on the spot, which is the one thing this row does that its neighbours do not.
             */
            NavigationDrawerItem(
                label = {
                    Text(
                        state.tag ?: stringResource(R.string.tags_label),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                badge = {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                selected = state.tag != null,
                shape = Shapes.Row,
                onClick = onPickTag,
                modifier = item,
            )

            HorizontalDivider(Modifier.padding(vertical = Space.Medium))

            for (nb in state.notebooks) {
                NavigationDrawerItem(
                    label = { Text(nb.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    badge = { CountBadge(nb.count) },
                    selected = state.notebook == nb.name,
                    shape = Shapes.Row,
                    onClick = {
                        state.filterBy(notebook = nb.name, tag = null)
                        onPicked()
                    },
                    modifier = item,
                )
            }
        }

        /*
         * The footer: create on the left, manage on the right.
         *
         * Fixed rather than the last row of the scroll, so both are one tap from anywhere
         * in a long directory. Creating is the common act and reads as a row like the ones
         * above it; managing is rare and sits as an icon at the end, quiet but visible —
         * which is the affordance a long-press would not have been.
         */
        HorizontalDivider()
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = Space.Medium, vertical = Space.Small),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NavigationDrawerItem(
                label = { Text(stringResource(R.string.new_notebook)) },
                icon = { Icon(Icons.Default.Add, contentDescription = null) },
                selected = false,
                shape = Shapes.Row,
                onClick = onManageNotebooks,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onManageNotebooks) {
                Icon(
                    Icons.Default.Settings,
                    contentDescription = stringResource(R.string.manage_notebooks),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * The tags, as a sheet over the list rather than a screen of their own.
 *
 * A sheet because picking a tag narrows what is already on screen: the list stays behind
 * it, and dismissing leaves everything as it was. It is also how the filing and capture
 * sheets already pick things, so the gesture is one the app has taught before.
 *
 * "Any tag" leads, and is how the filter comes off — a chip cloud with no clear row makes
 * removing the last filter a puzzle. The title names the notebook when one is selected,
 * because picking a tag here narrows within it rather than escaping it, and that is not
 * something the user can be expected to infer.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun TagSheet(state: NotesState, onDismiss: () -> Unit, onPicked: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Space.Screen)
                .padding(bottom = Space.Screen),
        ) {
            val notebook = state.notebook
            Text(
                when (notebook) {
                    null -> stringResource(R.string.tags_pick)
                    UNFILED -> stringResource(R.string.tags_in_notebook, stringResource(R.string.inbox))
                    else -> stringResource(R.string.tags_in_notebook, notebook)
                },
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(Modifier.height(Space.Large))

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(Space.Small),
                verticalArrangement = Arrangement.spacedBy(Space.Small),
            ) {
                TagChip(
                    name = stringResource(R.string.tags_none),
                    count = null,
                    selected = state.tag == null,
                    onClick = {
                        state.filterBy(notebook = state.notebook, tag = null)
                        onPicked()
                    },
                )
                for (tag in state.tags) {
                    val selected = state.tag == tag.name
                    TagChip(
                        name = tag.name,
                        count = tag.count,
                        selected = selected,
                        onClick = {
                            // Tapping the selected tag clears it: a chip that is on can be turned off.
                            state.filterBy(notebook = state.notebook, tag = if (selected) null else tag.name)
                            onPicked()
                        },
                    )
                }
            }
        }
    }
}

/**
 * Sort and dates, and the way to settings.
 *
 * These are the two settings that used to sit at the bottom of the drawer. They are not
 * places to go, so they do not belong in a directory — but they cannot simply be hidden
 * either: a sort you cannot see is a list in an order you did not ask for. Both rows name
 * their current value, and the list's own title still carries an applied date range, so
 * neither filter is ever in force with nothing on screen saying so.
 */
@Composable
private fun NotesOverflow(
    state: NotesState,
    expanded: Boolean,
    onDismiss: () -> Unit,
    onSort: () -> Unit,
    onDates: () -> Unit,
    onSettings: () -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.sort_current, stringResource(state.sort.label))) },
            leadingIcon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) },
            onClick = {
                onDismiss()
                onSort()
            },
        )
        DropdownMenuItem(
            text = {
                val range = rangeLabel(state.from, state.to) ?: stringResource(R.string.dates_any)
                Text(stringResource(R.string.dates_current, range), maxLines = 1, overflow = TextOverflow.Ellipsis)
            },
            leadingIcon = { Icon(Icons.Default.DateRange, contentDescription = null) },
            trailingIcon = {
                // Clearing a range without reopening the picker, the same affordance the
                // drawer row carried. Only where there is something to clear.
                if (state.from != null || state.to != null) {
                    IconButton(
                        onClick = {
                            state.dateRange(null, null)
                            onDismiss()
                        },
                    ) {
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.dates_clear))
                    }
                }
            },
            onClick = {
                onDismiss()
                onDates()
            },
        )
        HorizontalDivider(Modifier.padding(vertical = Space.Hair))
        DropdownMenuItem(
            text = { Text(stringResource(R.string.settings_title)) },
            leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
            onClick = {
                onDismiss()
                onSettings()
            },
        )
    }
}

/**
 * The sort, as a dialog off the overflow.
 *
 * A submenu would have worked and would have been worse: the options are longer than a
 * menu row wants to be, and the current one has to be legible at a glance, which a nested
 * menu shows only after a second tap.
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
private fun DateRangeDialog(
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
    items: List<NoteSummary>,
    sort: NoteSort,
    showNotebook: Boolean,
    loadingMore: Boolean,
    onOpen: (String) -> Unit,
    onNearEnd: () -> Unit,
) {
    val listState = rememberLazyListState()

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
    var tag by mutableStateOf<String?>(null)
        private set
    var sort by mutableStateOf(NoteSort.UPDATED)
        private set
    /** Inclusive `YYYY-MM-DD` bounds, or null for open; see DateRange.kt. */
    var from by mutableStateOf<String?>(null)
        private set
    var to by mutableStateOf<String?>(null)
        private set
    val filtered: Boolean get() = notebook != null || tag != null || from != null || to != null

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

    /** Changes what the list shows. The screen reloads when it sees the change. */
    fun filterBy(notebook: String?, tag: String?) {
        if (this.notebook == notebook && this.tag == tag) return
        this.notebook = notebook
        this.tag = tag
        clearForReload()
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

    private fun clearForReload() {
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
        val result = withContext(Dispatchers.IO) { runCatching { api.search(q, notebook, tag, from, to) } }
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
        }
        withContext(Dispatchers.IO) { runCatching { api.listTags() } }.onSuccess { tags = it }
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
                    tag = tag,
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
        }.onFailure { e ->
            if ((e as? ApiException)?.status == 401) unauthorized = true
            else error = e.message ?: e.javaClass.simpleName
        }
    }
}
