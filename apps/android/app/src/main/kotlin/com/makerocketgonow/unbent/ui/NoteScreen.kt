package com.makerocketgonow.unbent.ui

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.view.ViewGroup
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.UnbentApp
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.Note
import com.makerocketgonow.unbent.api.SessionCookie
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.Space
import kotlin.concurrent.thread
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * One note: a native title in the bar, and the web page for everything under it.
 *
 * The title is this screen's, drawn and saved natively, and it sits in the app bar
 * beside the back arrow — the row the site's phone layout draws as the note's head,
 * with the save state at its right end and the menu after it. Everything below the bar
 * — the notebook, the tags, the fields and the body — is the site's own page at
 * `/embed/notes/:id`, in a WebView the app has signed in by writing its session cookie
 * into the jar: the same property list and the same editor the site's phone layout
 * draws, and no second implementation of any of it. The notebook and the tags used to be
 * this screen's too, a row that opened a sheet, drawn in a second font and rhythm over
 * the fields the page drew underneath; one list, in one place, is what ended that.
 *
 * The title used to be a row of its own under the bar, above the page: three bands —
 * the bar, the title, the page — where the site has two, and the page scrolled under a
 * title that stayed put while the bar above it held only a status. With the title in
 * the bar the page is the whole of the screen below it and scrolls as one document, the
 * way the site's phone note scrolls under its sticky head.
 *
 * The two halves write different fields, and PATCH is partial on the server, so they
 * cannot overwrite each other. Leaving flushes both: the page is asked to save whatever
 * it is holding and the title's debounce is run out, and the screen pops once the page
 * reports it is no longer saving, or after two seconds if it never does.
 *
 * The page's Attach button is the site's own, in the editor's bar; what the app adds is
 * the file chooser behind it, since a WebView opens no picker of its own. See
 * FileChooser.kt for the pieces, and [leave] for what happens to a file still on its way
 * when the user presses Back.
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
    var confirmLeave by remember { mutableStateOf(false) }

    /*
     * With a file still uploading, Back asks first. Back is reflexive on a phone, and a
     * note left mid-upload would keep the page's `![uploading …]` placeholder for ever:
     * the WebView that could have replaced it dies with this screen. Leaving anyway
     * tells the page to abandon the uploads — the placeholders go, and the flush that
     * follows saves a note without them — rather than leaving it to the next save.
     *
     * The scripts are awaited, not fired and forgotten. The page reports through the
     * bridge while a script runs, so its report is queued on the main thread before the
     * script's completion is; waiting for the completion means the save state sampled
     * below is the one the page just posted, not the one from before.
     */
    fun leave(force: Boolean = false) {
        if (leaving) return
        if (!force && state.uploading > 0) {
            confirmLeave = true
            return
        }
        leaving = true
        scope.launch {
            val page = webView
            if (force) page?.evaluate(NoteBridge.ABANDON_SCRIPT)
            page?.evaluate(NoteBridge.FLUSH_SCRIPT)
            state.flushTitle()
            withTimeoutOrNull(2_000) {
                snapshotFlow { state.bodySave }.first { it != "saving" && it != "dirty" }
            }
            onBack()
        }
    }
    BackHandler { leave() }

    /*
     * The file chooser. The page asks through the WebChromeClient below with a callback;
     * the system picker answers through the launcher; a chosen HEIC is transcoded off the
     * main thread on the way back. `request` is what keeps the two ends honest — see
     * FileChooserRequest for why an unanswered callback is worse than a cancelled one.
     */
    val appContext = context.applicationContext
    val request = remember { FileChooserRequest() }
    val attachDir = remember { AttachCache.dir(appContext) }
    // The JPEGs made for the page go with the screen. The WebView is destroyed with it,
    // so nothing can still be reading them.
    DisposableEffect(attachDir) {
        onDispose { thread { attachDir.deleteRecursively() } }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val chosen = trustedUris(appContext, chosenUris(result.resultCode, result.data))
        if (chosen.isEmpty()) {
            request.answer(null)
        } else {
            // Answered on the main thread, where the WebView expects it; the screen's own
            // scope, because a screen that has gone has no WebView left to answer.
            scope.launch {
                val ready = withContext(Dispatchers.IO) {
                    runCatching { AttachCache.prepare(appContext, chosen, attachDir) }.getOrDefault(chosen)
                }
                request.answer(ready.toTypedArray())
            }
        }
    }
    val chooseFiles: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean = { callback, params ->
        request.open(callback)
        // `createIntent` is GET_CONTENT with OPENABLE, the accepted types, and multiple
        // selection when the input allows it; nothing to add. A phone with no picker
        // throws here, and false is how Chromium is told the request was not taken.
        runCatching { picker.launch(params.createIntent()) }
            .onFailure { request.forget() }
            .isSuccess
    }

    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                // Only once the note is here: a placeholder "Untitled" that flips to the
                // real title a moment later is a jump the bar does not need.
                title = {
                    if (state.note != null) {
                        TitleField(state.title, onChange = state::changeTitle, takeFocus = focusTitle)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { leave() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    // At the title's right end, before the menu, where the site puts it.
                    SaveStatus(state.headerSave, state.bodySave, state.uploading)
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
                    modifier = Modifier.padding(Space.Screen),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                state.error != null -> Column(Modifier.padding(Space.Screen), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.load_failed, state.error!!), color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(Space.Medium))
                    OutlinedButton(onClick = { scope.launch { state.load() } }) { Text(stringResource(R.string.retry)) }
                }

                note == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }

                else -> {
                    // The rule under the site's note head; the bar itself draws none.
                    HorizontalDivider()
                    NoteWebView(
                        origin = prefs.instance,
                        session = prefs.session,
                        noteId = noteId,
                        onMessage = state::onBridge,
                        onChooseFiles = chooseFiles,
                        onCreated = { webView = it },
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                    )
                }
            }
        }
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

    if (confirmLeave) {
        val count = state.uploading
        if (count == 0) {
            // The reason for asking has gone, and the user already said they want to go.
            LaunchedEffect(Unit) {
                confirmLeave = false
                leave()
            }
        } else {
            AlertDialog(
                onDismissRequest = { confirmLeave = false },
                title = { Text(stringResource(R.string.leave_attaching_title)) },
                text = { Text(pluralStringResource(R.plurals.leave_attaching_body, count, count)) },
                // Plain, not red: the note itself is safe either way. Only the files
                // still on their way are dropped, and they were never in it yet.
                confirmButton = {
                    TextButton(
                        onClick = {
                            confirmLeave = false
                            leave(force = true)
                        },
                    ) { Text(stringResource(R.string.leave_anyway)) }
                },
                dismissButton = {
                    TextButton(onClick = { confirmLeave = false }) { Text(stringResource(R.string.leave_keep_waiting)) }
                },
            )
        }
    }
}

/**
 * One line for both halves' saving, as the web shows one for the whole note.
 *
 * Failure outranks everything; then a file still uploading; then anything still on its
 * way; then a quiet "Saved" when either has just landed. Nothing at all while nothing
 * has happened, so a freshly opened note does not announce a save that never was.
 *
 * Attaching sits above saving because while a large file uploads the body's own save has
 * usually landed already — the placeholder autosaves within a second — so "Saving…"
 * would go quiet with the file still on its way, and "Saved" would be a lie.
 */
@Composable
private fun SaveStatus(header: String, body: String, uploading: Int) {
    val text = when {
        header == "error" || body == "error" -> stringResource(R.string.save_error)
        uploading > 0 -> stringResource(R.string.attach_attaching)
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

/**
 * The title: a bare field with the size of a heading, as on the web. No border, no label.
 *
 * Sized for the app bar's title slot, which sets the inset from the back arrow and the
 * gap to the actions itself; the field adds no padding of its own.
 */
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
    /** The page wants a file; true when a picker was opened for it. */
    onChooseFiles: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean,
    onCreated: (WebView) -> Unit,
    modifier: Modifier,
) {
    val dark = isSystemInDarkTheme()
    /*
     * The theme, handed to the page on its URL.
     *
     * The page draws the property list and the editor under this screen's native title,
     * and it used to paint them in the site's own tokens — a grey-white ground and a
     * different green under Material's lavender-tinted surface, in a different face. The
     * roles the page needs are sent as hex and it paints its own tokens from them, so
     * the two halves of the screen share ink and ground, and follow this theme if it
     * ever changes. Six-digit hex without the hash, which is what the page validates.
     */
    val scheme = MaterialTheme.colorScheme
    fun hex(color: Color) = "%06x".format(color.toArgb() and 0xFFFFFF)
    val theme = listOf(
        "surface" to scheme.surface,
        "onSurface" to scheme.onSurface,
        "onSurfaceVariant" to scheme.onSurfaceVariant,
        "outlineVariant" to scheme.outlineVariant,
        "primary" to scheme.primary,
        "primaryContainer" to scheme.primaryContainer,
        "onPrimaryContainer" to scheme.onPrimaryContainer,
        "error" to scheme.error,
    ).joinToString("&") { (role, color) -> "$role=${hex(color)}" }
    // The factory below runs once and keeps what it captured; these are read through
    // State so the closure sees the latest lambda rather than the first.
    val currentOnMessage by rememberUpdatedState(onMessage)
    val currentOnChooseFiles by rememberUpdatedState(onChooseFiles)

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
                webChromeClient = object : WebChromeClient() {
                    override fun onShowFileChooser(
                        webView: WebView,
                        filePathCallback: ValueCallback<Array<Uri>>,
                        fileChooserParams: FileChooserParams,
                    ): Boolean = currentOnChooseFiles(filePathCallback, fileChooserParams)
                }
                setDownloadListener { url, _, contentDisposition, mimeType, _ ->
                    download(ctx, url, contentDisposition, mimeType, session)
                }
                if (session != null) WebSession.install(origin, session)
                loadUrl("$origin/embed/notes/$noteId?$theme")
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

/**
 * `evaluateJavascript`, awaited: resumes once the page has run the script.
 *
 * Bounded, because a WebView destroyed before the script finishes never calls back, and
 * a leave that waited on it would never pop.
 */
private suspend fun WebView.evaluate(script: String) {
    withTimeoutOrNull(1_000) {
        suspendCancellableCoroutine { cont ->
            evaluateJavascript(script) { if (cont.isActive) cont.resume(Unit) }
        }
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

    /** Files the page is still uploading, as it reports them. Back asks while this is above zero. */
    var uploading by mutableStateOf(0)
        private set

    private var titleJob: Job? = null

    suspend fun load() {
        error = null
        val result = withContext(Dispatchers.IO) { runCatching { api.getNote(noteId) } }
        result.onSuccess {
            note = it
            title = it.title
        }.onFailure { e ->
            when ((e as? ApiException)?.status) {
                401 -> unauthorized = true
                404 -> missing = true
                else -> error = e.message ?: e.javaClass.simpleName
            }
        }
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

    fun onBridge(message: BridgeMessage) {
        val saveState = message.saveState
        when {
            message.isUnauthorized -> unauthorized = true
            message.isMissing -> missing = true
            saveState != null -> bodySave = saveState
            else -> message.uploadsPending?.let { uploading = it }
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
