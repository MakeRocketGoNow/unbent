package com.makerocketgonow.unbent.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.Notebook
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.Shapes
import com.makerocketgonow.unbent.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Renaming, deleting and creating notebooks.
 *
 * A screen of its own rather than controls on the drawer's rows. The drawer is where you
 * go to a notebook, and hanging an overflow menu off every row there would put a rarely
 * used control on every line of the app's main navigation — density belongs to the
 * content, and the notebooks are the content. Reached from the drawer's footer instead,
 * directly under the list it manages, so it reads as a continuation of that list rather
 * than a separate place that happens to hold the same names.
 *
 * The list here duplicates the drawer's, which is a real cost and worth it: delete needs
 * room for a two-option confirm, rename needs a field the row can become, and both need
 * somewhere to put an error. None of that fits in a drawer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManageNotebooksScreen(
    api: UnbentApi,
    /** Set when the user arrived by tapping "New notebook", so the field is ready. */
    focusCreate: Boolean = false,
    onBack: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val state = remember(api) { NotebooksState(api) }
    val createFocus = remember { FocusRequester() }
    LaunchedEffect(focusCreate) { if (focusCreate) createFocus.requestFocus() }

    LaunchedEffect(state) { state.load() }
    if (state.unauthorized) LaunchedEffect(Unit) { onUnauthorized() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.manage_notebooks)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .fillMaxSize(),
        ) {
            /*
             * Creating sits at the top, above the list.
             *
             * Below it, on an account with a hundred notebooks, the field would be off the
             * bottom of a screen the user has to scroll to reach — and it is the one thing
             * here that is not about an existing row.
             */
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Space.Large, vertical = Space.Medium),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.draft,
                    onValueChange = state::changeDraft,
                    placeholder = { Text(stringResource(R.string.notebook_new_hint)) },
                    singleLine = true,
                    enabled = !state.busy,
                    shape = Shapes.Row,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { scope.launch { state.create() } }),
                    modifier = Modifier.weight(1f).focusRequester(createFocus),
                )
                Spacer(Modifier.width(Space.Small))
                Button(
                    onClick = { scope.launch { state.create() } },
                    enabled = !state.busy && state.draft.isNotBlank(),
                ) { Text(stringResource(R.string.notebook_create)) }
            }

            state.error?.let { message ->
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Space.Large, vertical = Space.Hair),
                )
            }

            HorizontalDivider()

            when {
                !state.loaded -> Spacer(Modifier.height(Space.Large))
                state.notebooks.isEmpty() -> Text(
                    stringResource(R.string.notebook_none),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(Space.Large),
                )

                else -> Unit
            }

            LazyColumn(Modifier.weight(1f)) {
                items(state.notebooks, key = { it.id }) { notebook ->
                    NotebookRow(
                        notebook = notebook,
                        editing = state.editing?.id == notebook.id,
                        draft = state.editing?.value.orEmpty(),
                        busy = state.busy,
                        onDraft = state::changeRename,
                        onStartRename = { state.startRename(notebook) },
                        onCommitRename = { scope.launch { state.commitRename() } },
                        onCancelRename = state::cancelRename,
                        onDelete = { state.askDelete(notebook) },
                    )
                    HorizontalDivider()
                }

                item {
                    Text(
                        stringResource(R.string.notebook_manage_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(Space.Large),
                    )
                }
            }
        }
    }

    state.pendingDelete?.let { notebook ->
        DeleteNotebookDialog(
            notebook = notebook,
            busy = state.busy,
            onDismiss = state::cancelDelete,
            onDelete = { cascade -> scope.launch { state.confirmDelete(cascade) } },
        )
    }
}

/**
 * One notebook: its name and count, or the field it becomes while being renamed.
 *
 * The field replaces the name in place rather than opening anywhere else — a control that
 * moves what it is editing reads as jank. Rename is the row itself, since renaming is what
 * the row is mostly for; delete is a button at the trailing edge, quiet because it repeats
 * on every row and destructive so it must never be the thing a stray tap finds.
 */
@Composable
private fun NotebookRow(
    notebook: Notebook,
    editing: Boolean,
    draft: String,
    busy: Boolean,
    onDraft: (String) -> Unit,
    onStartRename: () -> Unit,
    onCommitRename: () -> Unit,
    onCancelRename: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.Large, vertical = Space.Small),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (editing) {
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            OutlinedTextField(
                value = draft,
                onValueChange = onDraft,
                singleLine = true,
                enabled = !busy,
                shape = Shapes.Row,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onCommitRename() }),
                modifier = Modifier.weight(1f).focusRequester(focus),
            )
            TextButton(onClick = onCancelRename, enabled = !busy) {
                Text(stringResource(R.string.cancel))
            }
            TextButton(onClick = onCommitRename, enabled = !busy) {
                Text(stringResource(R.string.save))
            }
        } else {
            /*
             * A clickable Row rather than a TextButton: a button centres its content, which
             * put the name in the middle of the row with the count floating beside it and
             * nothing at the left edge where a list's names belong. The whole area is still
             * the target — it just aligns like the row it is.
             */
            Row(
                Modifier
                    .weight(1f)
                    .clip(Shapes.Row)
                    .clickable(enabled = !busy, onClick = onStartRename)
                    .padding(horizontal = Space.Small, vertical = Space.Medium),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    notebook.name,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.width(Space.Small))
                CountBadge(notebook.count)
            }
            TextButton(onClick = onDelete, enabled = !busy) {
                Text(
                    stringResource(R.string.notebook_delete),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

/**
 * The two ways to delete a notebook, and the difference between them.
 *
 * Both are offered as buttons rather than a checkbox and one button, because they are two
 * different acts and the quieter one is not a modifier of the other. Keeping the notes is
 * the confirm button and reads as the default; the cascade is a text button below it, so
 * moving a hundred notes to the trash has to be reached for rather than tapped through.
 * The cascade is only offered when there is something to cascade.
 */
@Composable
private fun DeleteNotebookDialog(
    notebook: Notebook,
    busy: Boolean,
    onDismiss: () -> Unit,
    onDelete: (cascade: Boolean) -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.notebook_delete_title, notebook.name)) },
        text = {
            Text(
                stringResource(
                    if (notebook.count == 0) {
                        R.string.notebook_delete_empty
                    } else {
                        R.string.notebook_delete_keep
                    },
                ),
            )
        },
        confirmButton = {
            Column(horizontalAlignment = Alignment.End) {
                TextButton(onClick = { onDelete(false) }, enabled = !busy) {
                    Text(stringResource(R.string.notebook_delete_only))
                }
                if (notebook.count > 0) {
                    TextButton(onClick = { onDelete(true) }, enabled = !busy) {
                        Text(
                            pluralStringResource(
                                R.plurals.notebook_delete_cascade,
                                notebook.count,
                                notebook.count,
                            ),
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
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
 * The notebook list and the one edit in flight.
 *
 * Every mutation reloads the list rather than patching it in place: a rename can be
 * refused by the server for a reason this screen cannot predict, and a list that had
 * already moved on would show a name the account does not have.
 */
private class NotebooksState(private val api: UnbentApi) {
    var notebooks by mutableStateOf<List<Notebook>>(emptyList())
        private set
    var loaded by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var unauthorized by mutableStateOf(false)
        private set

    var draft by mutableStateOf("")
        private set

    /** The notebook being renamed, with what has been typed so far. */
    var editing by mutableStateOf<Editing?>(null)
        private set
    var pendingDelete by mutableStateOf<Notebook?>(null)
        private set

    data class Editing(val id: String, val value: String)

    fun changeDraft(value: String) {
        draft = value
    }

    fun changeRename(value: String) {
        editing = editing?.copy(value = value)
    }

    fun startRename(notebook: Notebook) {
        error = null
        pendingDelete = null
        editing = Editing(notebook.id, notebook.name)
    }

    fun cancelRename() {
        editing = null
    }

    fun askDelete(notebook: Notebook) {
        error = null
        editing = null
        pendingDelete = notebook
    }

    fun cancelDelete() {
        pendingDelete = null
    }

    suspend fun load() {
        withContext(Dispatchers.IO) { runCatching { api.listNotebooks() } }
            .onSuccess {
                notebooks = it.notebooks
                loaded = true
            }
            .onFailure { report(it) }
    }

    suspend fun create() {
        val name = draft.trim()
        if (name.isEmpty() || busy) return
        run {
            api.createNotebook(name)
            draft = ""
        }
    }

    suspend fun commitRename() {
        val edit = editing ?: return
        val name = edit.value.trim()
        val original = notebooks.find { it.id == edit.id }?.name
        // A no-op rename would 409 against the notebook's own name.
        if (name.isEmpty() || name == original) {
            editing = null
            return
        }
        run {
            api.renameNotebook(edit.id, name)
            editing = null
        }
    }

    suspend fun confirmDelete(cascade: Boolean) {
        val target = pendingDelete ?: return
        run {
            api.deleteNotebook(target.id, trashNotes = cascade)
            pendingDelete = null
        }
    }

    /** Runs one mutation off the main thread, then reloads. */
    private suspend fun run(action: () -> Unit) {
        busy = true
        error = null
        withContext(Dispatchers.IO) { runCatching(action) }
            .onSuccess { load() }
            .onFailure { report(it) }
        busy = false
    }

    /**
     * The server's own explanation where it gave one.
     *
     * A name clash is a refusal the user can act on — "that name is taken" says what to do
     * next, where "couldn't rename" sends them to try the same thing again.
     */
    private fun report(err: Throwable) {
        if (err is ApiException && err.status == 401) unauthorized = true
        error = (err as? ApiException)?.serverMessage() ?: err.message
    }
}
