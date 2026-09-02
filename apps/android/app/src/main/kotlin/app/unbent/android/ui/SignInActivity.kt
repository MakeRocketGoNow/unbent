package app.unbent.android.ui

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import app.unbent.android.BuildConfig
import app.unbent.android.Prefs
import app.unbent.android.R
import app.unbent.android.api.ApiException
import app.unbent.android.api.AppConfig
import app.unbent.android.api.ConnectAuth
import app.unbent.android.api.GoogleAuth
import app.unbent.android.api.PasswordAuth
import app.unbent.android.api.SessionCookie
import app.unbent.android.api.UnbentApi
import app.unbent.android.ui.theme.UnbentTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Signs this phone in to an Unbent account, by whichever methods the instance offers.
 *
 * Google goes through Android's own account sheet and shows no web page. GitHub, which has
 * no native sheet, opens /connect in a Custom Tab — the browser, with the browser's own
 * session — and comes back through the `unbent://connect` deep link with a one-time token
 * this activity exchanges for a session. A password goes straight to the API. All three
 * end in the same place: the session cookie stored in [Prefs], and the app continues.
 *
 * `singleTop` plus `onNewIntent` is what catches the redirect: the tab returns to this
 * already-running activity rather than starting a second copy.
 */
class SignInActivity : ComponentActivity() {

    private val prefs by lazy { Prefs(this) }

    /*
     * Screen state lives on the activity rather than in a ViewModel: there is one screen,
     * its state is four values, and the one thing a ViewModel would add — surviving
     * rotation — costs at most a repeated /api/config request here.
     */
    private var instance by mutableStateOf("")
    private var config by mutableStateOf<AppConfig?>(null)
    private var configError by mutableStateOf<String?>(null)
    private var status by mutableStateOf<String?>(null)
    private var busy by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = prefs.instance
        loadConfig()

        /*
         * Ask for notifications here rather than at launch. This screen stays up, so the
         * dialog has somewhere to sit. Android 13+ needs it before a capture can report
         * success or failure, and a capture that reports neither looks like one that was
         * silently dropped.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        setContent {
            UnbentTheme {
                SignInScreen(
                    instance = instance,
                    config = config,
                    configError = configError,
                    status = status,
                    busy = busy,
                    onGoogle = ::signInWithGoogle,
                    onGitHub = ::openConnectPage,
                    onPassword = ::signInWithPassword,
                    onInstanceChange = ::changeInstance,
                    onRetry = ::loadConfig,
                )
            }
        }

        // Launched by the deep link itself, when the activity was not already running.
        consume(intent)
    }

    /** Asks the instance which methods to draw. Nothing else can show until it answers. */
    private fun loadConfig() {
        config = null
        configError = null
        lifecycleScope.launch {
            val origin = prefs.instance
            val result = withContext(Dispatchers.IO) { runCatching { UnbentApi(origin, null).config() } }
            result.onSuccess { config = it }.onFailure { e ->
                Log.w("Unbent", "Could not load /api/config from $origin", e)
                configError = getString(R.string.sign_in_unreachable, origin.removePrefix("https://"))
            }
        }
    }

    private fun changeInstance(raw: String) {
        val normalized = Prefs.normalizeOrigin(raw)
        if (normalized.isEmpty()) return
        prefs.instance = normalized
        instance = normalized
        status = null
        loadConfig()
    }

    /**
     * Android's own account sheet: no web page, one tap.
     *
     * A build without a Google client id cannot ask for the sheet, so it falls back to the
     * browser, where the site's own Google button works — the same path GitHub takes.
     */
    private fun signInWithGoogle() {
        if (!GoogleAuth.isConfigured(BuildConfig.GOOGLE_WEB_CLIENT_ID)) {
            openConnectPage()
            return
        }
        busy = true
        status = getString(R.string.sign_in_waiting)
        lifecycleScope.launch {
            val result = runCatching {
                GoogleAuth(prefs.instance).signIn(this@SignInActivity, BuildConfig.GOOGLE_WEB_CLIENT_ID)
            }
            busy = false
            result.onSuccess(::finishSignIn).onFailure { e ->
                /*
                 * Dismissing the sheet is a choice, not an error — say nothing and leave
                 * the user on this screen with the other methods still there. Any other
                 * failure gets the server's own words when it has some ("this instance is
                 * not open for sign-ups"), since a generic message sends the user to retry
                 * a button that will refuse them again for the same reason.
                 */
                Log.w("Unbent", "Google sign-in failed", e)
                status = when {
                    GoogleAuth.wasCancelled(e) -> null
                    else -> (e as? ApiException)?.serverMessage()
                        ?: getString(R.string.sign_in_google_failed)
                }
            }
        }
    }

    private fun signInWithPassword(email: String, password: String, name: String?) {
        busy = true
        status = getString(R.string.sign_in_waiting)
        lifecycleScope.launch {
            val origin = prefs.instance
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val auth = PasswordAuth(origin)
                    if (name == null) auth.signIn(email, password)
                    else auth.signUp(email, password, name.ifBlank { email })
                }
            }
            busy = false
            result.onSuccess(::finishSignIn).onFailure { e ->
                Log.w("Unbent", "Password sign-in failed", e)
                status = (e as? ApiException)?.serverMessage() ?: getString(R.string.sign_in_failed)
            }
        }
    }

    /** The browser, for a provider with no native sheet. See [ConnectAuth]. */
    private fun openConnectPage() {
        status = getString(R.string.sign_in_intro)
        val tab = CustomTabsIntent.Builder().setShowTitle(true).build()
        runCatching {
            tab.launchUrl(this, Uri.parse(ConnectAuth(prefs.instance).connectUrl(BuildConfig.CONNECT_SCHEME)))
        }.onFailure {
            status = getString(R.string.sign_in_failed)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consume(intent)
    }

    /** Redeems the token a redirect carried, if this intent is one. Returns whether it was. */
    private fun consume(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != BuildConfig.CONNECT_SCHEME || data.host != "connect") return false

        val token = data.getQueryParameter("token")
        if (token.isNullOrEmpty()) {
            status = getString(R.string.sign_in_denied)
            return true
        }

        busy = true
        status = getString(R.string.sign_in_waiting)
        lifecycleScope.launch {
            val origin = prefs.instance
            val result = withContext(Dispatchers.IO) { runCatching { ConnectAuth(origin).redeem(token) } }
            busy = false
            result.onSuccess(::finishSignIn).onFailure { e ->
                status = (e as? ApiException)?.serverMessage() ?: e.message ?: getString(R.string.sign_in_failed)
            }
        }
        return true
    }

    private fun finishSignIn(session: SessionCookie) {
        prefs.session = session
        status = getString(R.string.sign_in_done)
        setResult(RESULT_OK)
        continueToApp()
        finish()
    }

    /**
     * Reopens the app when sign-in interrupted a launch.
     *
     * The launcher finishes itself before showing this screen, so without this the user
     * ends up back at the home screen after signing in rather than in the app they opened.
     */
    private fun continueToApp() {
        if (intent?.getBooleanExtra(EXTRA_THEN_LAUNCH, false) == true) {
            startActivity(Intent(this, EntryActivity::class.java))
        }
    }

    companion object {
        /** Set when sign-in replaced a launch, so success reopens the app. */
        const val EXTRA_THEN_LAUNCH = "thenLaunch"
    }
}
