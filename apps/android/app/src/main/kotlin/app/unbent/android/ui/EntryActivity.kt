package app.unbent.android.ui

import android.content.Intent
import android.os.Bundle
import androidx.lifecycle.lifecycleScope
import app.unbent.android.Prefs
import app.unbent.android.api.ConnectAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The app icon. Decides whether to sign in first, then gets out of the way.
 *
 * A separate activity because the launcher cannot make this choice itself: LaunchActivity
 * extends the TWA helper's own, whose `onCreate` opens the website immediately. Anything
 * conditional there either gets covered by the site a moment later or has to skip
 * `super.onCreate`, which Android rejects outright.
 *
 * Draws nothing and finishes at once, so there is no flash and nothing to come back to.
 */
class EntryActivity : androidx.appcompat.app.AppCompatActivity() {

    /** The path part of a notification's target, or the notes list when there is none. */
    private fun pathOf(url: String?, origin: String): String =
        url?.removePrefix(origin)?.takeIf { it.startsWith("/") } ?: "/notes"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        /*
         * Sign the app in when the app is opened, which is the one moment a person expects
         * to be asked. The site itself is signed in through the browser's cookies, but the
         * app's own process cannot read those and its uploader needs a credential — so
         * without this the first thing that ever asked for one was a share.
         */
        val prefs = Prefs(this)
        if (!prefs.isSignedIn) {
            startActivity(
                Intent(this, SignInActivity::class.java)
                    .putExtra(SignInActivity.EXTRA_THEN_LAUNCH, true),
            )
            finish()
            return
        }

        /*
         * Hand this app's session to the browser before showing the site.
         *
         * The web activity renders unbent.app with the *browser's* cookies, and signing in
         * through Android's account sheet never touches those — so a user who just signed
         * in successfully was shown a login page. Minting a one-time token here and opening
         * /handoff with it puts the browser in the same session the app already holds.
         *
         * Off the main thread because it is a network call, and best-effort: if it fails,
         * the site still opens and shows its own sign-in, which is where this started
         * rather than anywhere worse.
         */
        val target = intent?.getStringExtra(LaunchActivity.EXTRA_URL)
        lifecycleScope.launch {
            val url = withContext(Dispatchers.IO) {
                val session = prefs.token
                if (session.isNullOrEmpty()) null
                else {
                    val auth = ConnectAuth(prefs.instance)
                    auth.mintHandoffToken(session)?.let { ott ->
                        auth.handoffUrl(ott, pathOf(target, prefs.instance))
                    }
                }
            }

            val next = Intent(this@EntryActivity, LaunchActivity::class.java)
            (url ?: target)?.let { next.putExtra(LaunchActivity.EXTRA_URL, it) }
            startActivity(next)
            finish()
        }
    }
}
