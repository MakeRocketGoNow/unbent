package app.unbent.android.ui

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.view.ViewGroup
import android.webkit.URLUtil
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import app.unbent.android.Prefs
import app.unbent.android.R
import app.unbent.android.UnbentApp
import app.unbent.android.api.ApiException
import app.unbent.android.api.Filing
import app.unbent.android.api.Note
import app.unbent.android.api.Notebook
import app.unbent.android.api.SessionCookie
import app.unbent.android.api.Tag
import app.unbent.android.api.UnbentApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * One note: a native head, and the web editor for the body.
 *
 * The title, the notebook and the tags are this screen's, drawn and saved natively. The
 * body below them is the site's own editor at `/embed/notes/:id`, in a WebView the app
 * has signed in by writing its session cookie into the jar — the same editor, the same
 * code, and no second implementation of the one part of the app that is genuinely hard.
 *
 * The two halves write different fields, and PATCH is partial on the server, so they
 * cannot overwrite each other. Leaving flushes both: the page is asked to save whatever
 * it is holding and the title's debounce is run out, and the screen pops once the page
 * reports it is no longer saving, or after two seconds if it never does.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteScreen(
    noteId: String,
    api: UnbentApi,
    /** A note just created: the title takes focus, because a new note starts with its name. */
    focusTitle: Boolean = false,
    prefs: Prefs,
    onBack: () -> Unit,
    onUnauthorized: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val saves = (context.applicationContext as UnbentApp).saves
    val state = remember(noteId) { NoteState(api, noteId, saves) }
    LaunchedEffect(state) { state.load() }
    if (state.unauthorized) LaunchedEffect(Unit) { onUnauthorized() }

    var webView by remember { mutableStateOf<WebView?>(null) }
    var leaving by remember { mutableStateOf(false) }

    fun leave() {
        if (leaving) return
        leaving = true
        scope.launch {
            webView?.evaluateJavascript(NoteBridge.FLUSH_SCRIPT, null)
            state.flushTitle()
            withTimeoutOrNull(2_000) {
                snapshotFlow { state.bodySave }.first { it != "saving" && it != "dirty" }
            }
            onBack()
        }
    }
    BackHandler { leave() }

    var showFiling by rememberSaveable { mutableStateOf(false) }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { SaveStatus(state.headerSave, state.bodySave) },
                navigationIcon = {
                    IconButton(onClick = ::leave) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.more))
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.note_open_web)) },
                            onClick = {
                                menuOpen = false
                                runCatching {
                                    CustomTabsIntent.Builder().build()
                                        .launchUrl(context, Uri.parse("${prefs.instance}/notes/$noteId"))
                                }
                            },
                        )
                        /*
                         * Delete sits behind the menu rather than beside the title on
                         * purpose, as on the web: a destructive control a single tap from
                         * the title is a misclick waiting to happen, and the dialog that
                         * follows names what is about to move.
                         */
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.note_delete), color = MaterialTheme.colorScheme.error) },
                            onClick = {
                                menuOpen = false
                                confirmDelete = true
                            },
                        )
                    }
                },
            )
        },
    ) { padding ->
        /*
         * `imePadding` is what shrinks the editor above the keyboard. Scaffold's own insets
         * cover the system bars only, and without this the WebView keeps its full height
         * under the keyboard — with the page's docked formatting bar, which sits at the
         * bottom of the WebView's viewport, hidden exactly when it is needed.
         *
         * The Scaffold padding is consumed first, or the keyboard inset is applied on top
         * of the navigation bar's and a bar-sized gap opens between the two.
         */
        Column(
            Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .fillMaxSize(),
        ) {
            val note = state.note
            when {
                state.missing -> Text(
                    stringResource(R.string.note_missing),
                    modifier = Modifier.padding(24.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                state.error != null -> Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.load_failed, state.error!!), color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(onClick = { scope.launch { state.load() } }) { Text(stringResource(R.string.retry)) }
                }

                note == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }

                else -> {
                    TitleField(state.title, onChange = state::changeTitle, takeFocus = focusTitle)
                    FilingRow(state.notebook, state.tags, onClick = { showFiling = true })
                    HorizontalDivider()
                    NoteWebView(
                        origin = prefs.instance,
                        session = prefs.session,
                        noteId = noteId,
                        onMessage = state::onBridge,
                        onCreated = { webView = it },
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                    )
                }
            }
        }
    }

    if (showFiling) {
        FilingSheet(state, onDismiss = { showFiling = false })
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.note_delete_title)) },
            text = {
                Text(stringResource(R.string.note_delete_body, state.title.ifBlank { stringResource(R.string.untitled) }))
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = false
                        scope.launch { if (state.delete()) onBack() }
                    },
                ) { Text(stringResource(R.string.note_delete), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

/**
 * One line for both halves' saving, as the web shows one for the whole note.
 *
 * Failure outranks everything; then anything still on its way; then a quiet "Saved" when
 * either has just landed. Nothing at all while nothing has happened, so a freshly opened
 * note does not announce a save that never was.
 */
@Composable
private fun SaveStatus(header: String, body: String) {
    val text = when {
        header == "error" || body == "error" -> stringResource(R.string.save_error)
        header == "saving" || body == "saving" -> stringResource(R.string.save_saving)
        header == "dirty" || body == "dirty" -> stringResource(R.string.save_unsaved)
        header == "saved" || body == "saved" -> stringResource(R.string.save_saved)
        else -> ""
    }
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = if (text == stringResource(R.string.save_error)) MaterialTheme.colorScheme.error
        else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** The title: a bare field with the size of a heading, as on the web. No border, no label. */
@Composable
private fun TitleField(value: String, onChange: (String) -> Unit, takeFocus: Boolean) {
    val style = MaterialTheme.typography.titleLarge.copy(color = MaterialTheme.colorScheme.onSurface)
    val focus = remember { FocusRequester() }
    LaunchedEffect(takeFocus) { if (takeFocus) focus.requestFocus() }
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = style,
        singleLine = true,
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .focusRequester(focus),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) {
                    Text(stringResource(R.string.untitled), style = style, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                inner()
            }
        },
    )
}

/**
 * The note's filing, stated on one line, as the web's phone layout does.
 *
 * Read far more often than changed, so it states the notebook and the tags and a tap
 * opens the controls, rather than spending two rows of pickers between the title and
 * the first line of the note.
 */
@Composable
private fun FilingRow(notebook: String?, tags: List<String>, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            notebook ?: stringResource(R.string.inbox),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // The tags take whatever width is left, truncating rather than wrapping, so the
        // chevron always sits at the right edge; with no tags an empty spacer does the same.
        if (tags.isNotEmpty()) {
            Spacer(Modifier.width(10.dp))
            Text(
                tags.joinToString(" ") { "#$it" },
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        } else {
            Spacer(Modifier.weight(1f))
        }
        Icon(
            Icons.Default.ArrowDropDown,
            contentDescription = stringResource(R.string.filing_title),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Notebook and tags in one sheet: the same disclosure the web's phone layout opens. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun FilingSheet(state: NoteState, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var newNotebook by rememberSaveable { mutableStateOf("") }
    var newTag by rememberSaveable { mutableStateOf("") }

    fun addTag() {
        val tag = newTag.trim()
        if (tag.isNotEmpty() && state.tags.none { it.equals(tag, ignoreCase = true) }) {
            state.changeTags(state.tags + tag)
        }
        newTag = ""
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
        ) {
            Text(stringResource(R.string.notebook_label), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            NotebookChoice(stringResource(R.string.inbox), null, state.notebook == null) { state.changeNotebook(null) }
            for (nb in state.notebooks) {
                NotebookChoice(nb.name, nb.count, state.notebook == nb.name) { state.changeNotebook(nb.name) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = newNotebook,
                    onValueChange = { newNotebook = it },
                    placeholder = { Text(stringResource(R.string.new_notebook)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        state.createNotebook(newNotebook)
                        newNotebook = ""
                    }),
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = {
                        state.createNotebook(newNotebook)
                        newNotebook = ""
                    },
                    enabled = newNotebook.isNotBlank(),
                ) { Text(stringResource(R.string.add)) }
            }

            Spacer(Modifier.height(20.dp))
            Text(stringResource(R.string.tags_label), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (tag in state.tags) {
                    InputChip(
                        selected = false,
                        onClick = { state.changeTags(state.tags - tag) },
                        label = { Text(tag) },
                        trailingIcon = {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.remove_tag, tag))
                        },
                    )
                }
            }
            OutlinedTextField(
                value = newTag,
                onValueChange = { newTag = it },
                placeholder = { Text(stringResource(R.string.add_tag)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { addTag() }),
                modifier = Modifier.fillMaxWidth(),
            )
            // The tags this account already uses, minus the ones on the note, narrowed by
            // what has been typed: an archive's tags are a vocabulary, not free text.
            val suggestions = state.allTags
                .filter { s -> state.tags.none { it.equals(s.name, ignoreCase = true) } }
                .filter { newTag.isBlank() || it.name.contains(newTag.trim(), ignoreCase = true) }
                .take(12)
            if (suggestions.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (s in suggestions) {
                        SuggestionChip(
                            onClick = {
                                state.changeTags(state.tags + s.name)
                                newTag = ""
                            },
                            label = { Text(s.name) },
                        )
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
            Button(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) {
                Text(stringResource(R.string.done))
            }
        }
    }
}

/** One notebook to pick, with its note count where it has one; the Inbox has none. */
@Composable
private fun NotebookChoice(name: String, count: Int?, selected: Boolean, onSelect: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onSelect).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(name, modifier = Modifier.weight(1f))
        if (count != null) {
            Text(
                count.toString(),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The editor: the site's `/embed/notes/:id`, signed in with the app's own session.
 *
 * Every load stamps the cookie first, so a cleared jar or a fresh sign-in cannot leave the
 * page showing a login screen inside the app. Links stay inside only when they are the
 * page itself or the API — an attachment opening inline, a file downloading — and every
 * other link, on this site or another, opens in a browser tab where a link belongs.
 */
@Composable
private fun NoteWebView(
    origin: String,
    session: SessionCookie?,
    noteId: String,
    onMessage: (BridgeMessage) -> Unit,
    onCreated: (WebView) -> Unit,
    modifier: Modifier,
) {
    val dark = isSystemInDarkTheme()
    val currentOnMessage by rememberUpdatedState(onMessage)

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // The editor sets its own type size; pinch-zooming an editor is a mistake
                // waiting to be made with a thumb.
                settings.setSupportZoom(false)
                applyDarkMode(this, dark)
                addJavascriptInterface(NoteBridge { currentOnMessage(it) }, NoteBridge.NAME)
                webViewClient = NoteWebViewClient(origin, ctx)
                setDownloadListener { url, _, contentDisposition, mimeType, _ ->
                    download(ctx, url, contentDisposition, mimeType, session)
                }
                if (session != null) WebSession.install(origin, session)
                loadUrl("$origin/embed/notes/$noteId")
                onCreated(this)
            }
        },
        onRelease = { it.destroy() },
    )
}

/**
 * Dark mode for the page, on devices that do not derive it from the app theme.
 *
 * From API 33 the WebView reads `prefers-color-scheme` off the activity's theme and this
 * does nothing. Below that, force-dark with the web-theme-only strategy asks the page for
 * its own dark stylesheet — which it has — and never algorithmically inverts anything.
 */
@Suppress("DEPRECATION")
private fun applyDarkMode(view: WebView, dark: Boolean) {
    if (Build.VERSION.SDK_INT >= 33) return
    val settings = view.settings
    if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
        WebSettingsCompat.setForceDark(
            settings,
            if (dark) WebSettingsCompat.FORCE_DARK_ON else WebSettingsCompat.FORCE_DARK_OFF,
        )
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK_STRATEGY)) {
        WebSettingsCompat.setForceDarkStrategy(settings, WebSettingsCompat.DARK_STRATEGY_WEB_THEME_DARKENING_ONLY)
    }
}

private class NoteWebViewClient(private val origin: String, private val context: Context) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        val path = url.path.orEmpty()
        val inside = url.toString().startsWith("$origin/") &&
            (path.startsWith("/embed/") || path.startsWith("/api/"))
        if (inside) return false
        runCatching { CustomTabsIntent.Builder().build().launchUrl(context, url) }
        return true
    }
}

/**
 * An attachment the page asked to download, fetched with the app's session.
 *
 * DownloadManager runs outside the WebView and so outside its cookie jar; the cookie goes
 * on the request by hand. Into the public Downloads folder where the platform allows it
 * without a permission, and into the app's own files below that.
 */
private fun download(
    context: Context,
    url: String,
    contentDisposition: String?,
    mimeType: String?,
    session: SessionCookie?,
) {
    val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
    val request = DownloadManager.Request(Uri.parse(url)).apply {
        if (session != null) addRequestHeader("Cookie", "${session.name}=${session.value}")
        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        } else {
            setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
        }
    }
    runCatching { context.getSystemService(DownloadManager::class.java)?.enqueue(request) }
}

/**
 * The note's native half: what the head shows and saves, and what the page reports.
 *
 * Saves run on the application's scope rather than the screen's, so a title typed and
 * then backed out of still lands. Loading runs on the caller's, because a load for a
 * screen that has gone is worth nothing.
 */
class NoteState(
    private val api: UnbentApi,
    val noteId: String,
    private val saves: CoroutineScope,
) {
    var note by mutableStateOf<Note?>(null)
        private set
    var title by mutableStateOf("")
        private set
    var notebook by mutableStateOf<String?>(null)
        private set
    var tags by mutableStateOf<List<String>>(emptyList())
        private set
    var notebooks by mutableStateOf<List<Notebook>>(emptyList())
        private set
    var allTags by mutableStateOf<List<Tag>>(emptyList())
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var missing by mutableStateOf(false)
        private set
    var unauthorized by mutableStateOf(false)
        private set

    /** The head's own saving: idle, dirty, saving, saved or error, as the web names them. */
    var headerSave by mutableStateOf("idle")
        private set

    /** The body's, as the page reports it through the bridge. */
    var bodySave by mutableStateOf("idle")
        private set

    private var titleJob: Job? = null

    suspend fun load() {
        error = null
        val result = withContext(Dispatchers.IO) { runCatching { api.getNote(noteId) } }
        result.onSuccess {
            note = it
            title = it.title
            notebook = it.notebook
            tags = it.tags
        }.onFailure { e ->
            when ((e as? ApiException)?.status) {
                401 -> unauthorized = true
                404 -> missing = true
                else -> error = e.message ?: e.javaClass.simpleName
            }
        }
        if (note == null) return

        // The filing choices, after the note: the sheet shows whatever has arrived by the
        // time it opens, and a failure here is nothing worth stopping the note for.
        withContext(Dispatchers.IO) { runCatching { api.listNotebooks().notebooks } }.onSuccess { notebooks = it }
        withContext(Dispatchers.IO) { runCatching { api.listTags() } }.onSuccess { allTags = it }
    }

    /** Debounced like the web's autosave, and flushed by [flushTitle] when leaving. */
    fun changeTitle(value: String) {
        title = value
        headerSave = "dirty"
        titleJob?.cancel()
        titleJob = saves.launch {
            delay(800)
            patch { api.updateNote(noteId, title = title) }
        }
    }

    suspend fun flushTitle() {
        val pending = titleJob ?: return
        if (!pending.isActive) return
        pending.cancel()
        patch { api.updateNote(noteId, title = title) }
    }

    fun changeNotebook(name: String?) {
        notebook = name
        saves.launch {
            patch { api.updateNote(noteId, filing = Filing(name)) }
            // The counts beside the notebooks changed with this note's move; a stale "0"
            // beside the notebook it was just filed in reads as the move having failed.
            withContext(Dispatchers.IO) { runCatching { api.listNotebooks().notebooks } }
                .onSuccess { notebooks = it }
        }
    }

    fun changeTags(next: List<String>) {
        tags = next
        saves.launch { patch { api.updateNote(noteId, tags = next) } }
    }

    /** Creates the notebook and files the note in it, which is why anyone types one here. */
    fun createNotebook(rawName: String) {
        val name = rawName.trim()
        if (name.isEmpty()) return
        saves.launch {
            val created = withContext(Dispatchers.IO) { runCatching { api.createNotebook(name) } }
            created.onSuccess { nb ->
                notebooks = (notebooks + nb).sortedBy { it.name.lowercase() }
                changeNotebook(nb.name)
            }.onFailure { e ->
                // Taken already: file the note there instead, which is what was meant.
                if ((e as? ApiException)?.status == 409) changeNotebook(name) else headerSave = "error"
            }
        }
    }

    fun onBridge(message: BridgeMessage) {
        val saveState = message.saveState
        when {
            message.isUnauthorized -> unauthorized = true
            message.isMissing -> missing = true
            saveState != null -> bodySave = saveState
        }
    }

    suspend fun delete(): Boolean =
        withContext(Dispatchers.IO) { runCatching { api.deleteNote(noteId) } }.isSuccess

    /** One request, never cancelled mid-flight: a half-sent save is worse than a late one. */
    private suspend fun patch(block: () -> Note) {
        headerSave = "saving"
        val result = withContext(Dispatchers.IO + NonCancellable) { runCatching(block) }
        result.onSuccess {
            headerSave = "saved"
        }.onFailure { e ->
            if ((e as? ApiException)?.status == 401) unauthorized = true
            headerSave = "error"
        }
    }
}
