package com.makerocketgonow.unbent.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.NoteSummary
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The trash: what was deleted, and the two things you can do about it.
 *
 * Deleting a note on the phone used to say it was "restorable from the web app", which
 * was true and not much of an answer — the undo for this app's one destructive action
 * lived in a different app. A soft delete with no way back on the same device is not
 * really a soft delete.
 *
 * Emptying the trash lives here rather than in settings, where the web also keeps a copy
 * of it. A destructive action belongs beside the thing it destroys: from here the notes
 * it would take are on screen to be read first, which is the whole reason the trash is a
 * list and not a number.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(api: UnbentApi, onBack: () -> Unit, onUnauthorized: () -> Unit) {
    val scope = rememberCoroutineScope()
    val state = remember(api) { TrashState(api) }

    LaunchedEffect(state) { state.load() }
    if (state.unauthorized) LaunchedEffect(Unit) { onUnauthorized() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.trash))
                        state.total?.takeIf { it > 0 }?.let {
                            Text(
                                pluralStringResource(R.plurals.notes_count, it, it),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back),
                        )
                    }
                },
                actions = {
                    // Only where there is something to empty. On an empty trash the button
                    // would be a control that cannot do anything, next to a list saying so.
                    if (state.items.isNotEmpty()) {
                        TextButton(onClick = { state.askEmpty() }, enabled = !state.busy) {
                            Text(
                                stringResource(R.string.trash_empty_action),
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .fillMaxSize(),
        ) {
            state.emptied?.let { count ->
                Text(
                    pluralStringResource(R.plurals.trash_emptied, count, count),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Space.Large, vertical = Space.Small),
                )
            }

            state.message?.let { message ->
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (state.failed) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.padding(horizontal = Space.Large, vertical = Space.Small),
                )
            }

            when {
                !state.loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }

                state.items.isEmpty() -> Box(
                    Modifier.fillMaxSize().padding(Space.Screen),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    Text(
                        stringResource(R.string.trash_empty),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(state.items, key = { it.id }) { note ->
                        TrashRow(
                            note = note,
                            busy = state.busy,
                            onRestore = { scope.launch { state.restore(note) } },
                            onDelete = { state.askDelete(note) },
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }

    state.pendingDelete?.let { note ->
        ConfirmDialog(
            title = stringResource(
                R.string.trash_delete_title,
                note.title.ifBlank { stringResource(R.string.untitled) },
            ),
            body = stringResource(R.string.trash_delete_body),
            confirm = stringResource(R.string.trash_delete_forever),
            busy = state.busy,
            onDismiss = state::cancel,
            onConfirm = { scope.launch { state.purge(note) } },
        )
    }

    if (state.emptying) {
        ConfirmDialog(
            title = stringResource(R.string.trash_empty_title),
            body = stringResource(R.string.trash_empty_body),
            confirm = stringResource(R.string.trash_empty_action),
            busy = state.busy,
            onDismiss = state::cancel,
            onConfirm = { scope.launch { state.empty() } },
        )
    }
}

/**
 * One trashed note: what it was, and the two ways out.
 *
 * The row does not open the note. There is no editor for something that has been deleted,
 * and a tap that opened one would invite editing a note the account no longer really has
 * — restore is how you get it back, and then it is a note again.
 */
@Composable
private fun TrashRow(
    note: NoteSummary,
    busy: Boolean,
    onRestore: () -> Unit,
    onDelete: () -> Unit,
) {
    ListItem(
        headlineContent = {
            Text(
                note.title.ifBlank { stringResource(R.string.untitled) },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        supportingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onRestore, enabled = !busy) {
                    Text(stringResource(R.string.trash_restore))
                }
                Spacer(Modifier.height(Space.Hair))
                TextButton(onClick = onDelete, enabled = !busy) {
                    Text(
                        stringResource(R.string.trash_delete_forever),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
    )
}

/** One question, one destructive answer, and a way out. */
@Composable
private fun ConfirmDialog(
    title: String,
    body: String,
    confirm: String,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !busy) {
                Text(confirm, color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) {
                Text(stringResource(R.string.cancel))
            }
        },
    )
}

/**
 * The trashed notes and whatever is being asked about one of them.
 *
 * Every change reloads rather than editing the list in place: restoring takes a note out
 * of this list entirely, and the count in the title has to follow it.
 */
private class TrashState(private val api: UnbentApi) {
    var items by mutableStateOf<List<NoteSummary>>(emptyList())
        private set
    var total by mutableStateOf<Int?>(null)
        private set
    var loaded by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    var unauthorized by mutableStateOf(false)
        private set

    /** The last thing that happened, good or bad; [failed] says which. */
    var message by mutableStateOf<String?>(null)
        private set
    var failed by mutableStateOf(false)
        private set

    var pendingDelete by mutableStateOf<NoteSummary?>(null)
        private set
    var emptying by mutableStateOf(false)
        private set

    /** True when something here deleted or restored a note, so the list behind reloads. */
    var changed by mutableStateOf(false)
        private set

    fun askDelete(note: NoteSummary) {
        message = null
        pendingDelete = note
    }

    fun askEmpty() {
        message = null
        emptying = true
    }

    fun cancel() {
        pendingDelete = null
        emptying = false
    }

    suspend fun load() {
        withContext(Dispatchers.IO) { runCatching { api.listNotes(trashed = true) } }
            .onSuccess {
                items = it.items
                total = it.total
                loaded = true
            }
            .onFailure { report(it) }
    }

    suspend fun restore(note: NoteSummary) = run { api.restoreNote(note.id) }

    suspend fun purge(note: NoteSummary) = run {
        api.purgeNote(note.id)
        pendingDelete = null
    }

    suspend fun empty() {
        busy = true
        message = null
        withContext(Dispatchers.IO) { runCatching { api.emptyTrash() } }
            .onSuccess { result ->
                emptying = false
                changed = true
                emptied = result.notesDeleted
                load()
            }
            .onFailure { report(it) }
        busy = false
    }

    /**
     * How many the last empty removed, so the screen can say rather than imply.
     *
     * Held as a number instead of a formatted string because the plural belongs to the
     * composable that has the resources — state does not get to decide what "1 note"
     * reads like in another language.
     */
    var emptied by mutableStateOf<Int?>(null)
        private set

    private suspend fun run(action: () -> Unit) {
        busy = true
        message = null
        withContext(Dispatchers.IO) { runCatching(action) }
            .onSuccess {
                changed = true
                load()
            }
            .onFailure { report(it) }
        busy = false
    }

    private fun report(err: Throwable) {
        if (err is ApiException && err.status == 401) unauthorized = true
        failed = true
        message = (err as? ApiException)?.serverMessage() ?: err.message
    }
}
