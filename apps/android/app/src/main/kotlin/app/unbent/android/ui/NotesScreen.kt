package app.unbent.android.ui

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.foundation.clickable
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import app.unbent.android.R
import app.unbent.android.api.ApiException
import app.unbent.android.api.NoteSummary
import app.unbent.android.api.UnbentApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The note list: the plainest version that lets a note be opened.
 *
 * Deliberately the whole of this screen for now — titles, a line under each, and paging.
 * Search, the notebook and tag filters, sorting, pull to refresh and a way to create a
 * note are the next phase, and land on this screen rather than around it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotesScreen(
    api: UnbentApi,
    onOpen: (String) -> Unit,
    onSettings: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val state = remember(api) { NotesState(api) }

    /*
     * Reload whenever the screen comes to the front, not only when it is first shown.
     *
     * Coming back from a note re-enters this composable fresh, so that case takes care of
     * itself. Coming back to the app does not: a share from another app lands a note
     * while this activity sits in the background, and a list that only loaded once would
     * show the library as it was before. The lifecycle brings a new observer up to the
     * current state, so registering while resumed fires ON_RESUME at once and covers the
     * first load too.
     */
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, state) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) scope.launch { state.load() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    if (state.unauthorized) LaunchedEffect(Unit) { onUnauthorized() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_name)) },
                actions = {
                    IconButton(onClick = onSettings) {
                        Icon(Icons.Default.Settings, contentDescription = stringResource(R.string.settings_title))
                    }
                },
            )
        },
    ) { padding ->
        val error = state.error
        when {
            error != null && state.items.isEmpty() -> Column(
                Modifier.padding(padding).fillMaxSize().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(stringResource(R.string.load_failed, error), color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { scope.launch { state.load() } }) { Text(stringResource(R.string.retry)) }
            }

            state.loaded && state.items.isEmpty() -> Box(
                Modifier.padding(padding).fillMaxSize().padding(24.dp),
                contentAlignment = Alignment.TopCenter,
            ) {
                Text(stringResource(R.string.no_notes), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            !state.loaded -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }

            else -> NoteList(
                items = state.items,
                loadingMore = state.loading,
                onOpen = onOpen,
                onNearEnd = { scope.launch { state.loadMore() } },
                modifier = Modifier.padding(padding),
            )
        }
    }
}

@Composable
private fun NoteList(
    items: List<NoteSummary>,
    loadingMore: Boolean,
    onOpen: (String) -> Unit,
    onNearEnd: () -> Unit,
    modifier: Modifier,
) {
    val listState = rememberLazyListState()

    // Ask for the next page a few rows before the end, so scrolling never hits a wall.
    LaunchedEffect(listState, items.size) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (last >= items.size - 5) onNearEnd() }
    }

    LazyColumn(state = listState, modifier = modifier.fillMaxSize()) {
        itemsIndexed(items, key = { _, note -> note.id }) { index, note ->
            NoteRow(note, onClick = { onOpen(note.id) })
            if (index < items.lastIndex) HorizontalDivider()
        }
        if (loadingMore) {
            item {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
    }
}

/**
 * One note. The title, then where it is filed and when it changed, then a line of it.
 *
 * The notebook comes before the excerpt because in an archive this size it is how a
 * "Receipt" is told from the other forty; the excerpt is what the web list shows too.
 */
@Composable
private fun NoteRow(note: NoteSummary, onClick: () -> Unit) {
    val when_ = remember(note.updatedAt) {
        DateUtils.getRelativeTimeSpanString(
            note.updatedAt,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
            DateUtils.FORMAT_ABBREV_RELATIVE,
        ).toString()
    }
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = {
            Text(
                note.title.ifBlank { stringResource(R.string.untitled) },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        overlineContent = {
            Text("${note.notebook ?: stringResource(R.string.inbox)} · $when_")
        },
        supportingContent = note.excerpt?.takeIf { it.isNotBlank() }?.let { excerpt ->
            { Text(excerpt, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        },
    )
}

/** The list's data: pages, appended as they arrive. */
class NotesState(private val api: UnbentApi) {
    var items by mutableStateOf<List<NoteSummary>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var unauthorized by mutableStateOf(false)
        private set

    private var cursor: String? = null

    suspend fun load() = fetch(reset = true)

    suspend fun loadMore() {
        if (cursor != null && !loading) fetch(reset = false)
    }

    private suspend fun fetch(reset: Boolean) {
        loading = true
        error = null
        val result = withContext(Dispatchers.IO) {
            runCatching { api.listNotes(cursor = if (reset) null else cursor) }
        }
        loading = false
        result.onSuccess { page ->
            items = if (reset) page.items else items + page.items
            cursor = page.cursor
            loaded = true
        }.onFailure { e ->
            if ((e as? ApiException)?.status == 401) unauthorized = true
            else error = e.message ?: e.javaClass.simpleName
        }
    }
}
