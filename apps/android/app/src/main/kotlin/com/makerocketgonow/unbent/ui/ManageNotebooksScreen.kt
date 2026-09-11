package com.makerocketgonow.unbent.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DividerDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.Notebook
import com.makerocketgonow.unbent.api.UnbentApi
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
 * content, and the notebooks are the content. Reached from the drawer's section head
 * instead, directly above the list it manages, so it reads as a continuation of that list
 * rather than a separate place that happens to hold the same names.
 *
 * The list here duplicates the drawer's, which is a real cost and worth it: delete needs
 * room for a two-option confirm, rename needs a field the row can become, and both need
 * somewhere to put an error. None of that fits in a drawer.
 *
 * The shape is Keep's "Edit labels" screen, which the web app's editor will copy from
 * here. A row is its glyph, its name, its count and a pencil. Tapping it turns it into
 * the field in place, with a trash can where the glyph was and a check where the pencil
 * was: the two things you can do to a notebook, offered only once you have said which
 * one. Delete used to be a text button on every row, which put a destructive word on
 * every line of a list whose rows are mostly read, not changed; behind the pencil it is
 * still one tap from the field, and a stray tap on the list cannot find it. Creating is
 * a row at the top that becomes a field the same way, rather than an always-open field
 * and button above a list that rarely needs them.
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
    LaunchedEffect(focusCreate) { if (focusCreate) state.startCreate() }

    LaunchedEffect(state) { state.load() }
    if (state.unauthorized) LaunchedEffect(Unit) { onUnauthorized() }

    // Back leaves the row before it leaves the screen, the way it closes a drawer first.
    BackHandler(enabled = state.editing != null || state.creating) {
        state.cancelRename()
        state.cancelCreate()
    }

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
            state.error?.let { message ->
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Space.Large, vertical = Space.Hair),
                )
            }

            LazyColumn(Modifier.weight(1f)) {
                /*
                 * Creating sits at the top, above the list.
                 *
                 * Below it, on an account with a hundred notebooks, the row would be off
                 * the bottom of a screen the user has to scroll to reach — and it is the
                 * one thing here that is not about an existing row. Keep puts its
                 * "Create new label" in the same place.
                 */
                item(key = "create") {
                    CreateRow(
                        creating = state.creating,
                        draft = state.draft,
                        busy = state.busy,
                        onStart = state::startCreate,
                        onDraft = state::changeDraft,
                        onCommit = { scope.launch { state.create() } },
                        onCancel = state::cancelCreate,
                    )
                }

                items(state.notebooks, key = { it.id }) { notebook ->
                    NotebookRow(
                        notebook = notebook,
                        editing = state.editing?.id == notebook.id,
                        draft = state.editing?.value.orEmpty(),
                        busy = state.busy,
                        onDraft = state::changeRename,
                        onStartRename = { state.startRename(notebook) },
                        onCommitRename = { scope.launch { state.commitRename() } },
                        onDelete = { state.askDelete(notebook) },
                    )
                }

                item(key = "foot") {
                    Text(
                        stringResource(
                            if (state.loaded && state.notebooks.isEmpty()) R.string.notebook_none
                            else R.string.notebook_manage_hint,
                        ),
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
 * The field a row becomes.
 *
 * A bare field rather than an outlined one: the row is still the row, only now you can
 * type in it, and a box drawn around the name would make it jump into a different kind
 * of control. The dividers above and below the editing row (see [EditorRow]) are what
 * mark it out, which is how Keep draws the same state. Focus is taken on arrival, so the
 * keyboard is up with the cursor waiting — the promise a tap on a name makes.
 */
@Composable
private fun RowField(
    value: String,
    hint: String?,
    enabled: Boolean,
    onValue: (String) -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    /*
     * The caret starts at the end of the name, as Keep's does: a rename is usually an
     * addition or a correction at the end, and a caret at the start — where a bare
     * string value puts it — makes the first keystroke land in front of the name. The
     * selection is this field's own; the text stays the caller's.
     */
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    if (field.text != value) field = field.copy(text = value)
    val style = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface)
    BasicTextField(
        value = field,
        onValueChange = {
            field = it
            onValue(it.text)
        },
        singleLine = true,
        enabled = enabled,
        textStyle = style,
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = modifier.focusRequester(focus),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty() && hint != null) {
                    Text(hint, style = style, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                inner()
            }
        },
    )
}

/**
 * One row of the editor, in either state: a glyph, the middle, and a trailing control.
 *
 * One layout for both states so nothing moves when a row starts editing — the glyph's
 * slot takes the trash can, the pencil's slot takes the check, and the name becomes the
 * field at the same x. A control that moves what it is editing reads as jank. The row
 * being edited is fenced by a divider above and below, as Keep fences its own, so the
 * one row that is different is the one that looks different.
 */
@Composable
private fun EditorRow(
    editing: Boolean,
    leading: @Composable () -> Unit,
    trailing: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    middle: @Composable RowScope.() -> Unit,
) {
    /*
     * The dividers are always laid out and only sometimes drawn.
     *
     * Drawn only while editing, they added 2dp to the row the moment it started editing
     * and every row below it stepped down — the jump this row's whole layout exists to
     * avoid. Transparent dividers keep the geometry constant in both states.
     */
    val fence = if (editing) DividerDefaults.color else Color.Transparent
    Column {
        HorizontalDivider(color = fence)
        Row(
            modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .padding(start = Space.Hair, end = Space.Small),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            /*
             * The leading slot is a 48dp box with its content centred, whichever state the
             * row is in. A bare glyph and an icon button are different sizes — 24dp and
             * 48dp — and aligning both to the slot's start put the trash can's glyph 12dp
             * further in than the book it replaces, so the row's picture jumped right the
             * moment editing began. Centred, both glyphs sit 28dp from the edge: the
             * row's 4dp inset plus half the slot, which is where the book was before.
             */
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { leading() }
            Spacer(Modifier.width(Space.Medium))
            middle()
            trailing()
        }
        HorizontalDivider(color = fence)
    }
}

/** "Create new notebook", and the field it becomes. */
@Composable
private fun CreateRow(
    creating: Boolean,
    draft: String,
    busy: Boolean,
    onStart: () -> Unit,
    onDraft: (String) -> Unit,
    onCommit: () -> Unit,
    onCancel: () -> Unit,
) {
    if (creating) {
        EditorRow(
            editing = true,
            leading = {
                // Leaving, not deleting: there is nothing to delete yet, so the slot the
                // trash can takes on a real row takes a cross here.
                IconButton(onClick = onCancel, enabled = !busy) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.cancel))
                }
            },
            trailing = {
                IconButton(onClick = onCommit, enabled = !busy && draft.isNotBlank()) {
                    Icon(Icons.Default.Check, contentDescription = stringResource(R.string.notebook_create))
                }
            },
        ) {
            RowField(
                value = draft,
                hint = stringResource(R.string.notebook_new_hint),
                enabled = !busy,
                onValue = onDraft,
                onDone = onCommit,
                modifier = Modifier.weight(1f),
            )
        }
    } else {
        EditorRow(
            editing = false,
            leading = {
                Icon(
                    Icons.Default.Add,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            // Nothing trailing: the row is one act, and a pencil would promise editing
            // something that does not exist yet.
            trailing = {},
            modifier = Modifier.clickable(enabled = !busy, onClick = onStart),
        ) {
            Text(
                stringResource(R.string.notebook_create_row),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * One notebook: its glyph, name, count and a pencil — or, while being renamed, a trash
 * can, the field, and a check.
 *
 * Rename is the whole row, since renaming is what the row is mostly for; the pencil says
 * so, which a bare name did not. Delete appears only once the row is being edited: it is
 * destructive and must never be the thing a stray tap on a list finds, and the confirm
 * dialog behind it still names the notes at stake.
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
    onDelete: () -> Unit,
) {
    if (editing) {
        EditorRow(
            editing = true,
            leading = {
                IconButton(onClick = onDelete, enabled = !busy) {
                    Icon(Icons.Default.Delete, contentDescription = stringResource(R.string.notebook_delete))
                }
            },
            trailing = {
                IconButton(onClick = onCommitRename, enabled = !busy) {
                    Icon(Icons.Default.Check, contentDescription = stringResource(R.string.save))
                }
            },
        ) {
            RowField(
                value = draft,
                hint = null,
                enabled = !busy,
                onValue = onDraft,
                onDone = onCommitRename,
                modifier = Modifier.weight(1f),
            )
        }
    } else {
        EditorRow(
            editing = false,
            leading = {
                Icon(
                    painterResource(R.drawable.ic_notebook),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            trailing = {
                IconButton(onClick = onStartRename, enabled = !busy) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = stringResource(R.string.notebook_rename),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            modifier = Modifier.clickable(enabled = !busy, onClick = onStartRename),
        ) {
            Text(
                notebook.name,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f, fill = true),
            )
            CountBadge(notebook.count)
            Spacer(Modifier.width(Space.Small))
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
    /** Whether the create row is a field right now. */
    var creating by mutableStateOf(false)
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

    fun startCreate() {
        error = null
        editing = null
        pendingDelete = null
        creating = true
    }

    fun cancelCreate() {
        creating = false
        draft = ""
    }

    fun changeRename(value: String) {
        editing = editing?.copy(value = value)
    }

    fun startRename(notebook: Notebook) {
        error = null
        pendingDelete = null
        // One row at a time: two fields on one screen would be two places for the
        // keyboard to be about.
        cancelCreate()
        editing = Editing(notebook.id, notebook.name)
    }

    fun cancelRename() {
        editing = null
    }

    // The row stays in its editing state under the dialog: the trash can was reached
    // from there, and Cancel should land back where the finger left.
    fun askDelete(notebook: Notebook) {
        error = null
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
            // Back to the row, as Keep returns to "Create new label": one notebook was
            // asked for and one was made.
            creating = false
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
            // The row it was reached from is gone with it.
            editing = null
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
