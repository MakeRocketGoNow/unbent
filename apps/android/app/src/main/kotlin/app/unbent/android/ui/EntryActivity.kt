package app.unbent.android.ui

import android.content.Intent
import android.os.Bundle
import app.unbent.android.Prefs

/**
 * The app icon. Signs in first if the phone is not, then opens the site.
 *
 * Transitional: the site still opens in the web activity, with the browser's own session
 * rather than the app's. The two are separate by construction — Chrome's cookie jar is not
 * this app's — and the handoff that used to bridge them is gone rather than kept, because
 * the native shell that replaces the web activity makes the question go away.
 */
class EntryActivity : androidx.appcompat.app.AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Prefs(this).isSignedIn) {
            startActivity(
                Intent(this, SignInActivity::class.java)
                    .putExtra(SignInActivity.EXTRA_THEN_LAUNCH, true),
            )
            finish()
            return
        }

        val next = Intent(this, LaunchActivity::class.java)
        intent?.getStringExtra(LaunchActivity.EXTRA_URL)?.let { next.putExtra(LaunchActivity.EXTRA_URL, it) }
        startActivity(next)
        finish()
    }
}
