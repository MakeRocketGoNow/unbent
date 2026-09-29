package com.makerocketgonow.unbent.ui

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.makerocketgonow.unbent.BuildConfig
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.Space
import com.makerocketgonow.unbent.ui.theme.UnbentTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * The app: the site, whole, in one WebView.
 *
 * It used to draw its own note list, filters, notebooks, trash and settings in Compose,
 * with only a note's body in a WebView. Every feature the site gained then had to be built
 * a second time here, and the two drifted apart within a week. The site is already a phone
 * layout — it is held to that standard on purpose — so the app now shows it, and keeps as
 * native only what a page cannot do on Android: the share sheet ([ShareActivity]), sign-in
 * through the phone's account sheet ([SignInActivity]), the file picker and camera
 * ([AttachChooser]), saving into Downloads ([download], [SaveStreams]), and its own
 * address and version ([AppSettingsActivity]).
 *
 * The page and the app talk over the bridge in apps/web/src/app-bridge.ts ([NoteBridge]):
 * the page asks for the app's settings, reports a sign-out or a session it thinks has
 * ended, and says what colour it is; the app asks the page to handle Back and to open a
 * note in place.
 *
 * `singleTop` so a notification tapped while the app is open lands in [onNewIntent] rather
 * than stacking a second copy. Rotation and keyboard changes are handled in the manifest,
 * because recreating the activity would recreate the WebView and reload the site — a
 * cursor, an undo history and an upload in flight all gone mid-thought.
 */
class MainActivity : ComponentActivity() {

    private lateinit var prefs: Prefs
    private lateinit var origin: String
    private lateinit var chooser: AttachChooser
    private val saves by lazy { SaveStreams.downloads(applicationContext) }

    private var webView: WebView? = null

    /** Bumped to throw the WebView away and build a new one; see [onRenderProcessGone]. */
    private var generation by mutableIntStateOf(0)

    /** The page's ground, as the page reported it; the theme's surface until it has. */
    private var pageBackground by mutableStateOf<Color?>(null)

    /** The site could not be reached; a native panel says so instead of Chromium's page. */
    private var unreachable by mutableStateOf(false)

    /** Where the next WebView starts, when it is not the list: a notification's note. */
    private var pendingPath: String? = null

    /** The WebView's history from before the activity was recreated, to restore once. */
    private var savedWebState: Bundle? = null

    /** The address the last WebView was on when its renderer died, to go back to. */
    private var resumeUrl: String? = null

    private var checkingSession = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        prefs = Prefs(this)

        /*
         * Sign in when the app is opened, which is the one moment a person expects to be
         * asked. Nothing below works without a session, so there is nothing to show first.
         */
        if (!prefs.isSignedIn) {
            // Whatever the app was opened for — a link, a notification's note — waits for
            // the sign-in and is opened after it, rather than being dropped on the way.
            startActivity(
                Intent(this, SignInActivity::class.java)
                    .putExtra(SignInActivity.EXTRA_THEN_LAUNCH, true)
                    .putExtra(SignInActivity.EXTRA_THEN_OPEN, requestedPath(intent)),
            )
            finish()
            return
        }
        origin = prefs.instance

        AttachCache.sweep(this)
        chooser = AttachChooser(this, lifecycleScope)
        savedWebState = savedInstanceState?.getBundle(KEY_WEB_STATE)
        // A recreated activity is handed the intent it was first started with; acting on it
        // again would reopen a note the person has since left.
        if (savedInstanceState == null) consume(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = back()
        })

        setContent {
            UnbentTheme {
                Shell()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consume(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.let { view -> outState.putBundle(KEY_WEB_STATE, Bundle().also { view.saveState(it) }) }
    }

    /*
     * No `webView.onPause()` here, deliberately. It pauses the page's timers, which is the
     * autosave's debounce and an attachment's upload: a person who switches to the camera
     * app mid-upload would come back to find it had stopped. The page saves on
     * `visibilitychange` already, which the WebView fires as the app leaves the screen.
     * The cookies are written to disk, so a session refreshed while the app was open
     * survives the process being killed in the background.
     */
    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::chooser.isInitialized) chooser.close()
        // An export still streaming has lost the page that was writing it.
        saves.abortAll()
    }

    @Composable
    private fun Shell() {
        val surface = MaterialTheme.colorScheme.surface
        val dark = isSystemInDarkTheme()
        val ground = pageBackground ?: surface
        /*
         * The page is kept out from under the status and navigation bars, and the strips
         * behind them are painted in the page's own colour. A WebView tells a page nothing
         * about the system insets, so letting the page run underneath would put the topbar
         * under the clock and every sheet under the gesture bar, each needing CSS to learn
         * a number it cannot read. In the page's colour the strips read as the page running
         * to the edge; the keyboard's inset shrinks the page instead, so the editor's
         * docked toolbar sits on top of the keys.
         */
        Box(
            Modifier
                .fillMaxSize()
                .background(ground)
                .systemBarsPadding()
                .imePadding(),
        ) {
            key(generation) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { context -> createWebView(context, ground, dark) },
                    onRelease = { view ->
                        if (webView === view) webView = null
                        view.destroy()
                    },
                )
            }
            if (unreachable) Unreachable(onRetry = ::retry, onSettings = ::openAppSettings)
        }
    }

    private fun createWebView(context: Context, ground: Color, dark: Boolean): WebView =
        WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            // Painted before the first frame, so dark mode does not open on a white flash.
            setBackgroundColor(ground.toArgb())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The site sets its own type size; pinch-zooming an editor is a mistake waiting
            // to be made with a thumb.
            settings.setSupportZoom(false)
            // Needed for `target=_blank` to reach [ShellChrome.onCreateWindow] at all.
            settings.setSupportMultipleWindows(true)
            /*
             * Passkeys: Security's "Add a passkey" is WebAuthn, which a WebView refuses
             * unless the app opts in. The instance's asset links already vouch for this app,
             * which is the other half.
             */
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
                WebSettingsCompat.setWebAuthenticationSupport(
                    settings,
                    WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP,
                )
            }
            applyDarkMode(this, dark)
            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
            addJavascriptInterface(NoteBridge(saves) { onBridge(it) }, NoteBridge.NAME)
            webViewClient = ShellClient()
            webChromeClient = ShellChrome()
            setDownloadListener { url, _, contentDisposition, mimeType, _ ->
                // A `blob:` address belongs to the page; the site streams its exports
                // through the bridge instead, so one arriving here has nothing to fetch.
                if (!url.startsWith("blob:")) download(context, url, contentDisposition, mimeType)
            }
            webView = this

            prefs.session?.let { WebSession.install(origin, it) }
            val state = savedWebState
            savedWebState = null
            val restored = state != null && restoreState(state) != null
            if (!restored) loadUrl(resumeUrl ?: startUrl())
            resumeUrl = null
        }

    private fun startUrl(): String {
        val path = pendingPath ?: HOME
        pendingPath = null
        return origin + path
    }

    /** A notification's note, a link to the site, a path carried through sign-in, or the settings shortcut. */
    private fun consume(intent: Intent?) {
        if (intent == null) return
        if (intent.action == ACTION_SETTINGS) {
            openAppSettings()
            return
        }
        requestedPath(intent)?.let(::open)
        // A link to a site the app is not pointed at — after someone switched to their own
        // instance, a link to unbent.app still arrives here — opens where it belongs.
        val link = intent.data
        if (intent.action == Intent.ACTION_VIEW && link != null && linkPath(prefs.instance, link.toString()) == null) {
            openOutside(this, classify(prefs.instance, link.toString()))
        }
    }

    /** The page [intent] asks for, as a path on this site; null when it asks for none. */
    private fun requestedPath(intent: Intent?): String? {
        if (intent == null) return null
        intent.getStringExtra(EXTRA_NOTE_ID)?.let { return "/notes/" + Uri.encode(it) }
        intent.getStringExtra(EXTRA_PATH)?.takeIf(::isSitePath)?.let { return it }
        val link = intent.data
        if (intent.action == Intent.ACTION_VIEW && link != null) return linkPath(prefs.instance, link.toString())
        return null
    }

    /**
     * Goes to [path] on the site. In place when a page is up to ask, so a notification tapped
     * while the app is open does not reload the site under an upload in flight; by loading
     * it when the page cannot answer — still loading, or a deploy from before `open`.
     */
    private fun open(path: String) {
        val view = webView
        if (view == null) {
            pendingPath = path
            return
        }
        lifecycleScope.launch {
            val script = "(function(){var u=window.__unbent;return !!(u&&u.open&&u.open(${JSONObject.quote(path)}));})()"
            if (view.evaluate(script) != "true") view.loadUrl(origin + path)
        }
    }

    /**
     * Android's Back. The page first, because only it knows whether a sheet is open over
     * it; then the WebView's own history; then the app goes to the background rather than
     * finishing, the way a browser tab would be kept. Finishing would destroy the WebView,
     * and with it an upload in flight and everything the page held — the next launch would
     * reload the site from nothing.
     */
    private fun back() {
        val view = webView
        if (view == null || unreachable) {
            moveTaskToBack(true)
            return
        }
        lifecycleScope.launch {
            val canGoBack = view.canGoBack()
            val script = "(function(){var u=window.__unbent;return !!(u&&u.back&&u.back($canGoBack));})()"
            if (view.evaluate(script) == "true") return@launch
            if (view.canGoBack()) view.goBack() else moveTaskToBack(true)
        }
    }

    private fun onBridge(message: BridgeMessage) {
        when {
            message.isSignedOut -> signOutAndRestart()
            message.isUnauthorized -> checkSession()
            message.isAppSettings -> openAppSettings()
            else -> message.themeBackground?.let(::parseHex)?.let { pageBackground = it }
        }
    }

    /**
     * Whether the page is right that the session has ended, before acting on it.
     *
     * The page cannot tell a session the server no longer knows from a phone with no
     * signal: both leave it without a user, and both send it to its sign-in page and say
     * `unauthorized`. Signing out on the second would throw away a good thirty-day session
     * because of a tunnel. So the app asks the server itself: no user, or a 401, is a real
     * sign-out; anything else is the network, which gets the unreachable panel and keeps
     * the session for when it comes back. A session the server still honours sends the
     * page back to where it was bounced from.
     */
    private fun checkSession() {
        if (checkingSession) return
        val session = prefs.session ?: return signOutAndRestart()
        checkingSession = true
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { UnbentApi(origin, session.bearer).me() } }
            checkingSession = false
            result.fold(
                onSuccess = { user ->
                    if (user == null) {
                        signOutAndRestart()
                    } else {
                        WebSession.install(origin, session)
                        webView?.let { it.loadUrl(origin + returnPath(it.url, HOME)) }
                    }
                },
                onFailure = { error ->
                    if (error is ApiException && error.status == 401) signOutAndRestart() else unreachable = true
                },
            )
        }
    }

    private fun retry() {
        unreachable = false
        val view = webView ?: return
        val url = view.url
        // A page that fell to the site's own sign-in while offline goes back where it was
        // bounced from, or the list; the session was checked before this panel was shown.
        if (url == null || url.startsWith("about:") || Uri.parse(url).path?.startsWith("/login") == true) {
            prefs.session?.let { WebSession.install(origin, it) }
            view.loadUrl(origin + returnPath(url, HOME))
        } else {
            view.reload()
        }
    }

    private fun openAppSettings() {
        startActivity(AppSettingsActivity.intent(this))
    }

    /**
     * Back to sign-in, whether the user chose to leave or the server stopped knowing them.
     *
     * The WebView's jar is cleared too: a stale cookie there would let the page keep working
     * for a while on a session the app itself has forgotten.
     */
    private fun signOutAndRestart() {
        if (isFinishing) return
        prefs.clearSession()
        WebSession.clear()
        startActivity(
            Intent(this, SignInActivity::class.java)
                .putExtra(SignInActivity.EXTRA_THEN_LAUNCH, true),
        )
        finish()
    }

    /** Keeps the site in the WebView, and notices when it cannot be loaded or has crashed. */
    private inner class ShellClient : WebViewClient() {
        private val links by lazy { AppWebViewClient(origin, this@MainActivity) }

        /**
         * Whether the load in progress failed. Chromium commits its own error page after
         * reporting the error, and that commit must not take the panel down again.
         */
        private var failed = false

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            links.shouldOverrideUrlLoading(view, request)

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            failed = false
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            if (!failed) unreachable = false
        }

        /*
         * Only failures to reach the server. A navigation that turns into a download is
         * cancelled and reported as an error too, with the catch-all code, and showing a
         * panel over a page that is still there because a file started downloading would be
         * a lie.
         */
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && error.errorCode in UNREACHABLE) {
                failed = true
                unreachable = true
            }
        }

        // The site answers every page with the app itself, so a main-frame failure worth a
        // panel is the server's own: a 5xx. A 4xx is a real page saying something.
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 500) {
                failed = true
                unreachable = true
            }
        }

        /**
         * The page's renderer died — out of memory on a huge PDF, most likely. The WebView
         * that held it cannot be used again, not even to reload, so it is thrown away and a
         * new one built where it was, on the address it was showing. True tells the platform
         * this was handled, which is what keeps the whole app from being killed with it.
         */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                resumeUrl = view.url
                webView = null
                // An export the page was streaming has lost the page that was writing it, as
                // in onDestroy. Left open, its pending row in Downloads would sit there until
                // the activity went, beside whatever export the rebuilt page starts next.
                saves.abortAll()
                generation++
            }
            return true
        }
    }

    private inner class ShellChrome : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean = chooser.open(filePathCallback, fileChooserParams)

        /**
         * `target=_blank`. The new window is a throwaway that exists only to learn the
         * address it was asked to open, send it where it belongs, and go.
         *
         * Off the site that is a Custom Tab (or the mail app, the dialer): a second
         * WebView would run that page with this app's session in it. On the site it is
         * [open], the same in-place navigation a notification uses. Loading the address
         * into the app used to look right — there are no tabs — but a full navigation
         * destroys the page, so a link in a note dropped unsaved edits and an upload in
         * flight. In place, the editor flushes and the upload carries on.
         *
         * In place is still leaving the page, though, and a page that holds work of its
         * own loses it either way. The import panel is one: its worker ends when the panel
         * unmounts, so its skipped-note rows stay unlinked in the app while it runs
         * (`ImportSkips.tsx`) rather than rely on this.
         */
        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: Message,
        ): Boolean {
            if (!isUserGesture) return false
            val popup = WebView(view.context)
            var handled = false
            fun route(url: String) {
                if (handled || url.startsWith("about:")) return
                handled = true
                when (val destination = classify(origin, url)) {
                    // A `blob:`, `data:` or `javascript:` address the page made is dropped on
                    // purpose. It has no tab to go to, and loading it here would replace the
                    // page exactly as a same-origin link used to. Nothing on the site opens
                    // one in a new window; a feature that wants to should hand the app a path
                    // or a file, not rely on this.
                    Destination.InApp -> inAppWindowPath(origin, url)?.let { open(it) }
                    else -> openOutside(this@MainActivity, destination)
                }
                // Posted through the host, not the popup. The popup is never attached to a
                // window, and a view that is not attached holds what is posted to it until it
                // is, which here is never: every link off the site would leak a whole WebView.
                // Posted at all, rather than destroyed here, because this runs inside the
                // popup's own callbacks.
                view.post { popup.destroy() }
            }
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    route(request.url.toString())
                    return true
                }

                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    route(url)
                    view.stopLoading()
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = popup
            resultMsg.sendToTarget()
            return true
        }
    }

    companion object {
        const val EXTRA_NOTE_ID = "noteId"

        /** A path on the site to open, as sign-in hands back what the app was opened for. */
        const val EXTRA_PATH = "path"
        const val ACTION_SETTINGS = "com.makerocketgonow.unbent.SETTINGS"
        private const val KEY_WEB_STATE = "web"
        private const val HOME = "/notes"
        private val UNREACHABLE = setOf(
            WebViewClient.ERROR_HOST_LOOKUP,
            WebViewClient.ERROR_CONNECT,
            WebViewClient.ERROR_TIMEOUT,
            WebViewClient.ERROR_IO,
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE,
        )

        /** An intent that opens the app on one note. Used by the capture notification. */
        fun openNote(context: Context, noteId: String): Intent =
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_NOTE_ID, noteId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        /** `#rrggbb`, as the page sends it; null for anything else. */
        internal fun parseHex(value: String): Color? {
            val hex = value.trim().removePrefix("#")
            if (hex.length != 6 || !hex.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null
            return Color(0xFF000000 or hex.toLong(16))
        }
    }
}

/**
 * What shows when the site cannot be reached, in place of Chromium's own error page — which
 * names an error code, offers nothing to do, and looks like a different app.
 */
@Composable
private fun Unreachable(onRetry: () -> Unit, onSettings: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(Space.Screen),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                stringResource(R.string.unreachable_title),
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
            )
            Text(
                stringResource(R.string.unreachable_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = Space.Small, bottom = Space.Screen),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Space.Small)) {
                TextButton(onClick = onSettings) { Text(stringResource(R.string.app_settings_title)) }
                Button(onClick = onRetry) { Text(stringResource(R.string.retry)) }
            }
        }
    }
}
