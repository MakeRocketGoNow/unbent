package app.unbent.android.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import app.unbent.android.Prefs

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
class EntryActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        /*
         * Sign the app in when the app is opened, which is the one moment a person expects
         * to be asked. The site itself is signed in through the browser's cookies, but the
         * app's own process cannot read those and its uploader needs a credential — so
         * without this the first thing that ever asked for one was a share.
         */
        val next = if (Prefs(this).isSignedIn) {
            Intent(this, LaunchActivity::class.java)
        } else {
            Intent(this, SignInActivity::class.java)
                .putExtra(SignInActivity.EXTRA_THEN_LAUNCH, true)
        }

        // Carry a notification's target URL through to the web activity.
        intent?.getStringExtra(LaunchActivity.EXTRA_URL)?.let {
            next.putExtra(LaunchActivity.EXTRA_URL, it)
        }

        startActivity(next)
        finish()
    }
}
