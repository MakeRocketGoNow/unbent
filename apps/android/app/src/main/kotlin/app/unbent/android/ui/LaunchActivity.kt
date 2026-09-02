package app.unbent.android.ui

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
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

    override fun onCreate(savedInstanceState: Bundle?) {
        /*
         * Sign the app in when the app is opened, which is the only moment a person would
         * expect to be asked.
         *
         * Opening the icon shows the site already signed in, because the web activity uses
         * the browser's cookies — but the app's own process cannot read those, and the
         * uploader needs a credential of its own. Without this, the first thing that ever
         * asked for one was a share, so signing in ambushed the user at the exact moment
         * they were trying to do something else.
         *
         * Once this has run, sharing never shows anything: the token is already there.
         */
        if (!Prefs(this).isSignedIn) {
            startActivity(Intent(this, SignInActivity::class.java))
        }

        /*
         * Ask once, here, where a permission prompt makes sense. Android 13+ requires it
         * before any notification shows, and a capture that reports neither success nor
         * failure is indistinguishable from one that was dropped.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        super.onCreate(savedInstanceState)
    }

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
