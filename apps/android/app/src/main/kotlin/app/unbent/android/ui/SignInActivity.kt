package app.unbent.android.ui

import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import app.unbent.android.BuildConfig
import app.unbent.android.Prefs
import app.unbent.android.R
import app.unbent.android.api.ApiException
import app.unbent.android.api.ConnectAuth
import app.unbent.android.api.GoogleAuth
import app.unbent.android.databinding.ActivitySignInBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Connects this phone to an Unbent account.
 *
 * There is nothing to read out and nothing to type. The app opens /connect in a Custom Tab,
 * which carries the browser's own cookies — so if the phone is already signed in to Unbent,
 * the page is too, whichever provider was used. One tap on Connect sends a one-time token
 * back through a deep link, and this exchanges it for a session.
 *
 * A Custom Tab rather than a WebView: it is the browser, with the browser's session, and
 * Google refuses to run OAuth inside a WebView — so a WebView would break signing in with
 * Google even for a user who has never opened this app before.
 *
 * `singleTask` plus `onNewIntent` is what catches the redirect: the tab returns to this
 * already-running activity rather than starting a second copy.
 */
class SignInActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySignInBinding
    private val auth by lazy { ConnectAuth(Prefs(this).instance) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySignInBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.openButton.setOnClickListener { openConnectPage() }
        binding.googleButton.setOnClickListener { signInWithGoogle() }

        /*
         * Google gets a button, not an automatic prompt. An account here can be a GitHub
         * one, and throwing up a Google account sheet at someone who does not use Google is
         * a dialog they have to dismiss before they can reach the thing they wanted. The
         * button only appears when this build has a client id to ask with.
         */
        binding.googleButton.visibility =
            if (GoogleAuth.isConfigured(BuildConfig.GOOGLE_WEB_CLIENT_ID)) View.VISIBLE else View.GONE

        /*
         * Ask for notifications here rather than at launch. This screen stays up, so the
         * dialog has somewhere to sit; the launcher finishes immediately and would be gone
         * before the user could answer. Android 13+ needs it before a capture can report
         * success or failure, and a capture that reports neither looks like one that was
         * silently dropped.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        // Launched by the deep link itself, when the activity was not already running.
        consume(intent)
    }

    /** Android's own account sheet: no web page, one tap. Google accounts only. */
    private fun signInWithGoogle() {
        binding.status.setText(R.string.sign_in_waiting)
        lifecycleScope.launch {
            val result = runCatching {
                GoogleAuth(Prefs(this@SignInActivity).instance)
                    .signIn(this@SignInActivity, BuildConfig.GOOGLE_WEB_CLIENT_ID)
            }

            result.onSuccess { session ->
                Prefs(this@SignInActivity).token = session
                binding.status.setText(R.string.sign_in_done)
                setResult(RESULT_OK)
                continueToApp()
                finish()
            }.onFailure { e ->
                /*
                 * Dismissing the sheet is a choice, not an error — say nothing and leave
                 * the user on this screen, where the browser button is still there. Any
                 * other failure (no Google account, Play Services missing, an Unbent
                 * account that is not a Google one) gets a message pointing at the button
                 * that will work.
                 */
                // Logged as well as shown: the on-screen message cannot carry a status
                // code or a server body, and those are what say why it was refused.
                Log.w("Unbent", "Google sign-in failed", e)
                /*
                 * The server's own message when there is one — "this instance is not open
                 * for sign-ups" tells the user what actually happened, where a generic
                 * failure sends them to retry a button that will refuse them again.
                 */
                val refusal = (e as? ApiException)?.serverMessage()
                when {
                    GoogleAuth.wasCancelled(e) -> binding.status.setText(R.string.sign_in_intro)
                    refusal != null -> binding.status.text = refusal
                    else -> binding.status.setText(R.string.sign_in_google_failed)
                }
            }
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
            binding.status.setText(R.string.sign_in_denied)
            return true
        }

        binding.status.setText(R.string.sign_in_waiting)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { auth.redeem(token) } }
            result.onSuccess { session ->
                Prefs(this@SignInActivity).token = session
                binding.status.setText(R.string.sign_in_done)
                setResult(RESULT_OK)
                continueToApp()
                finish()
            }.onFailure { e ->
                binding.status.text = e.message ?: getString(R.string.save_failed)
            }
        }
        return true
    }

    /**
     * Reopens the app when sign-in interrupted a launch.
     *
     * LaunchActivity finishes itself before showing this screen, so without this the user
     * ends up back at the home screen after signing in rather than in the app they opened.
     */
    private fun continueToApp() {
        if (intent?.getBooleanExtra(EXTRA_THEN_LAUNCH, false) == true) {
            startActivity(Intent(this, LaunchActivity::class.java))
        }
    }

    private fun openConnectPage() {
        binding.status.setText(R.string.sign_in_intro)
        val tab = CustomTabsIntent.Builder().setShowTitle(true).build()
        runCatching {
            tab.launchUrl(this, Uri.parse(auth.connectUrl(BuildConfig.CONNECT_SCHEME)))
        }.onFailure {
            binding.status.text = getString(R.string.save_failed)
        }
    }

    companion object {
        /** Set when sign-in replaced a launch, so success reopens the app. */
        const val EXTRA_THEN_LAUNCH = "thenLaunch"
    }
}
