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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
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
    onUnauthorized: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val state = remember(api) { NotesState(api) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    var searchOpen by rememberSaveable { mutableStateOf(false) }

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
    BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }
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
                            IconButton(onClick = onSettings) {
                                Icon(Icons.Default.Settings, contentDescription = stringResource(R.string.settings_title))
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
                        Modifier.fillMaxSize().padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(stringResource(R.string.load_failed, error), color = MaterialTheme.colorScheme.error)
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(onClick = { scope.launch { state.load() } }) {
                            Text(stringResource(R.string.retry))
                        }
                    }

                    state.loaded && state.items.isEmpty() -> Box(
                        Modifier.fillMaxSize().padding(24.dp),
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
 * The directory: every notebook and tag with its count, the dates, and the sort.
 *
 * Counts are the point. In an archive of thirteen thousand notes, "Dentist 22" is the
 * information; a bare name would leave the user to open it and find out.
 *
 * The dates sit between the tags and the sort because they belong to both: a range
 * narrows like a tag does, and which date it reads follows the sort — created under
 * "Newest first", updated under everything else — the same rule the web applies.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterDrawer(state: NotesState, onPicked: () -> Unit) {
    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .padding(vertical = 16.dp),
    ) {
        Text(
            stringResource(R.string.app_name),
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = 28.dp, vertical = 8.dp),
        )

        val item = Modifier.padding(horizontal = 12.dp)
        NavigationDrawerItem(
            label = { Text(stringResource(R.string.all_notes)) },
            selected = state.notebook == null && state.tag == null,
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
                badge = { Text(state.unfiled.toString()) },
                selected = state.notebook == UNFILED,
                onClick = {
                    state.filterBy(notebook = UNFILED, tag = null)
                    onPicked()
                },
                modifier = item,
            )
        }
        for (nb in state.notebooks) {
            NavigationDrawerItem(
                label = { Text(nb.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                badge = { Text(nb.count.toString()) },
                selected = state.notebook == nb.name,
                onClick = {
                    state.filterBy(notebook = nb.name, tag = null)
                    onPicked()
                },
                modifier = item,
            )
        }

        if (state.tags.isNotEmpty()) {
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            Text(
                stringResource(R.string.tags_label),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 28.dp, vertical = 4.dp),
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(horizontal = 24.dp),
            ) {
                for (tag in state.tags) {
                    val selected = state.tag == tag.name
                    FilterChip(
                        selected = selected,
                        onClick = {
                            // Tapping the selected tag clears it: a chip that is on can be turned off.
                            state.filterBy(notebook = state.notebook, tag = if (selected) null else tag.name)
                            onPicked()
                        },
                        label = { Text("${tag.name} ${tag.count}") },
                    )
                }
            }
        }

        HorizontalDivider(Modifier.padding(vertical = 12.dp))
        Text(
            stringResource(R.string.dates_label),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 28.dp, vertical = 4.dp),
        )
        var pickingDates by rememberSaveable { mutableStateOf(false) }
        val range = rangeLabel(state.from, state.to)
        // Laid out like the sort rows beneath: an icon where their radio is, the label at the
        // same offset. The row opens the picker; the × beside a set range clears it, so
        // turning the filter off is one tap and never a trip through the dialog.
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { pickingDates = true }
                .padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.DateRange,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(24.dp),
            )
            Text(
                range ?: stringResource(R.string.dates_any),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 8.dp),
            )
            if (range != null) {
                IconButton(
                    onClick = {
                        state.dateRange(null, null)
                        onPicked()
                    },
                ) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.dates_clear))
                }
            }
        }
        if (pickingDates) {
            DateRangeDialog(
                from = state.from,
                to = state.to,
                onDismiss = { pickingDates = false },
                onPick = { from, to ->
                    pickingDates = false
                    state.dateRange(from, to)
                    onPicked()
                },
            )
        }

        HorizontalDivider(Modifier.padding(vertical = 12.dp))
        Text(
            stringResource(R.string.sort_label),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 28.dp, vertical = 4.dp),
        )
        for (sort in NoteSort.entries) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable {
                        state.sortBy(sort)
                        onPicked()
                    }
                    .padding(horizontal = 16.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = state.sort == sort, onClick = null)
                Text(stringResource(sort.label), modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
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
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
        // Room under the last row for the button that floats over the list.
        item { Spacer(Modifier.height(88.dp)) }
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
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.TopCenter) {
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
        item { Spacer(Modifier.height(88.dp)) }
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
