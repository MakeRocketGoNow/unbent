package com.makerocketgonow.unbent.ui

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.makerocketgonow.unbent.BuildConfig
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.AppConfig
import com.makerocketgonow.unbent.api.ConnectAuth
import com.makerocketgonow.unbent.api.EmailOtpAuth
import com.makerocketgonow.unbent.api.GoogleAuth
import com.makerocketgonow.unbent.api.PasskeyAuth
import com.makerocketgonow.unbent.api.PasswordAuth
import com.makerocketgonow.unbent.api.SessionCookie
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.UnbentTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Signs this phone in to an Unbent account, by whichever methods the instance offers.
 *
 * Google goes through Android's own account sheet and shows no web page. GitHub, which has
 * no native sheet, opens /connect in a Custom Tab (the browser, with the browser's own
 * session) and comes back through the `unbent://connect` deep link with a one-time token
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
     * its state is four values, and the one thing a ViewModel would add (surviving
     * rotation) costs at most a repeated /api/config request here.
     */
    private var instance by mutableStateOf("")
    private var config by mutableStateOf<AppConfig?>(null)
    private var configError by mutableStateOf<String?>(null)
    private var status by mutableStateOf<String?>(null)
    private var busy by mutableStateOf(false)
    /** The Turnstile page, while its widget wants a tap; see [TurnstileChallenge]. */
    private var challenge by mutableStateOf<WebView?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
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
                    onBrowserSocial = ::openConnectPage,
                    onPasskey = ::signInWithPasskey,
                    onEmailOtp = ::signInWithEmailOtp,
                    onPassword = ::signInWithPassword,
                    onInstanceChange = ::changeInstance,
                    onRetry = ::loadConfig,
                    challenge = challenge,
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
     * browser, where the site's own Google button works, the same path GitHub takes.
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
                 * Dismissing the sheet is a choice, not an error: say nothing and leave
                 * the user on this screen with the other methods still there. Any other
                 * failure gets the server's own words when it has some ("this instance is
                 * not open for sign-ups"), since a generic message sends the user to retry
                 * a button that will refuse them again for the same reason.
                 */
                Log.w("Unbent", "Google sign-in failed", e)
                status = when {
                    // Dismissing the sheet is a choice, so say nothing and leave the other
                    // methods where they were.
                    GoogleAuth.wasCancelled(e) -> null
                    // The cause most likely to have a fix the user can carry out, so it gets
                    // its own words, which suggest rather than assert, since NO_CREDENTIAL
                    // also covers failures that are ours. See GoogleAuth.hasNoAccount.
                    GoogleAuth.hasNoAccount(e) -> getString(R.string.sign_in_google_no_account)
                    // Anything the server explained gets the server's own words: "this instance
                    // is not open for sign-ups" sends someone to retry a button that will refuse
                    // them again for the same reason.
                    else -> (e as? ApiException)?.serverMessage()
                        ?: getString(R.string.sign_in_google_failed)
                }
            }
        }
    }

    /**
     * The credential sheet, for a passkey already made on this device or synced to it.
     *
     * No configuration to check first, unlike Google: a passkey needs no client id, only
     * the app-links document the instance serves (see [PasskeyAuth]). If there is nothing
     * to offer, the sheet says so by cancelling, which [PasskeyAuth.wasCancelled] treats
     * as a choice rather than a fault.
     */
    private fun signInWithPasskey() {
        busy = true
        status = getString(R.string.sign_in_waiting)
        lifecycleScope.launch {
            val result = runCatching { PasskeyAuth(prefs.instance).signIn(this@SignInActivity) }
            busy = false
            result.onSuccess(::finishSignIn).onFailure { e ->
                Log.w("Unbent", "Passkey sign-in failed", e)
                status = when {
                    PasskeyAuth.wasCancelled(e) -> null
                    else -> (e as? ApiException)?.serverMessage()
                        ?: getString(R.string.sign_in_passkey_failed)
                }
            }
        }
    }

    /**
     * Sends a code, or trades one for a session.
     *
     * One entry point for both steps because the screen drives the sequence: a null code
     * means "send one to this address", and a present one means "this is what arrived".
     * Sending reports nothing on success: the screen has already moved to the code field,
     * and a confirmation the user did not ask for would only be one more thing to read.
     *
     * Where the instance checks a Turnstile token with the request for a code
     * (`AppConfig.turnstile`), the token comes first, from the instance's own page in a
     * web view nobody sees unless the widget wants a tap ([TurnstileChallenge]). A page
     * that could not mint one ends the step with a sentence of its own: the server would
     * only refuse a request without it, and the person is one press from trying again.
     */
    private fun signInWithEmailOtp(email: String, code: String?) {
        busy = true
        status = getString(R.string.sign_in_waiting)
        lifecycleScope.launch {
            val origin = prefs.instance
            var captchaToken: String? = null
            if (code == null && config?.turnstile != null) {
                status = getString(R.string.sign_in_checking)
                val outcome = TurnstileChallenge.token(this@SignInActivity, origin) { challenge = it }
                if (outcome !is TurnstileChallenge.Outcome.Token) {
                    Log.w("Unbent", "Turnstile gave no token: $outcome")
                    busy = false
                    status = getString(R.string.sign_in_challenge_failed)
                    return@launch
                }
                captchaToken = outcome.token
                status = getString(R.string.sign_in_waiting)
            }
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val auth = EmailOtpAuth(origin)
                    if (code == null) {
                        auth.sendCode(email, captchaToken)
                        null
                    } else {
                        auth.signIn(email, code)
                    }
                }
            }
            busy = false
            result.onSuccess { session ->
                if (session == null) status = null else finishSignIn(session)
            }.onFailure { e ->
                Log.w("Unbent", "Email code sign-in failed", e)
                status = (e as? ApiException)?.serverMessage()
                    ?: getString(if (code == null) R.string.sign_in_failed else R.string.sign_in_otp_failed)
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

    /**
     * A sign-in screen that finds itself signed in has nothing left to ask.
     *
     * It happens: the app opens this screen and finishes itself, the person signs in from
     * somewhere else (the share sheet's own copy of this screen) and comes back to a
     * task whose only content is a stale sign-in form. Continuing into the app is what
     * they expect; a form to fill in again is not.
     */
    override fun onResume() {
        super.onResume()
        if (!busy && prefs.isSignedIn) {
            continueToApp()
            finish()
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
            startActivity(
                Intent(this, MainActivity::class.java)
                    .putExtra(MainActivity.EXTRA_PATH, intent?.getStringExtra(EXTRA_THEN_OPEN)),
            )
        }
    }

    companion object {
        /** Set when sign-in replaced a launch, so success reopens the app. */
        const val EXTRA_THEN_LAUNCH = "thenLaunch"

        /** The page the app was opened for, if any, to go to once signed in. */
        const val EXTRA_THEN_OPEN = "thenOpen"
    }
}
