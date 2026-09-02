package app.unbent.android.ui

import android.content.Intent
import app.unbent.android.Prefs
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * The app icon: unbent.app in a Trusted Web Activity.
 *
 * Chrome renders the site with Chrome's own cookies, so a phone already signed in to Unbent
 * in the browser is signed in here. That is also why this is not a WebView — Google refuses
 * OAuth sign-in inside one, which would leave GitHub as the only way in.
 *
 * The address bar disappears only once the assetlinks.json served from the site lists this
 * build's signing certificate; until then the same page shows with a Custom Tab toolbar,
 * which works but does not look like an app.
 */
class LaunchActivity : LauncherActivity() {

    override fun getLaunchingUrl(): android.net.Uri {
        // A notification tap carries the note it refers to; a plain icon tap has none.
        val explicit = intent?.getStringExtra(EXTRA_URL)
        if (!explicit.isNullOrEmpty()) return android.net.Uri.parse(explicit)
        return android.net.Uri.parse(Prefs(this).instance)
    }

    companion object {
        const val EXTRA_URL = "url"
    }
}
