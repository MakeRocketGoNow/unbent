package app.unbent.android.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import app.unbent.android.BuildConfig
import app.unbent.android.Prefs
import app.unbent.android.R
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
                finish()
            }.onFailure { e ->
                /*
                 * Dismissing the sheet is a choice, not an error — say nothing and leave
                 * the user on this screen, where the browser button is still there. Any
                 * other failure (no Google account, Play Services missing, an Unbent
                 * account that is not a Google one) gets a message pointing at the button
                 * that will work.
                 */
                binding.status.setText(
                    if (GoogleAuth.wasCancelled(e)) R.string.sign_in_intro
                    else R.string.sign_in_google_failed,
                )
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
                finish()
            }.onFailure { e ->
                binding.status.text = e.message ?: getString(R.string.save_failed)
            }
        }
        return true
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
}
