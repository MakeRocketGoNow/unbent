package app.unbent.android.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.unbent.android.Prefs
import app.unbent.android.api.UnbentApi
import app.unbent.android.ui.theme.UnbentTheme

/**
 * The app: a note list, one open note, and settings, in one activity.
 *
 * Everything the phone shows is native except the note's body, which is the web editor
 * rendered in a WebView on [NoteScreen] — that part is the same code as the site, on
 * purpose, and the rest is what should feel like the phone it runs on.
 *
 * `singleTop` so a notification tapped while the app is open lands in [onNewIntent] rather
 * than stacking a second copy of the activity. Rotation and keyboard changes are handled
 * in the manifest, because recreating the activity would recreate the WebView and throw
 * away the editor's cursor and undo history mid-thought.
 */
class MainActivity : ComponentActivity() {

    /** The note a notification or a share asked for, consumed by the navigation host. */
    private var requestedNote by mutableStateOf<String?>(null)
    private var requestedSettings by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        /*
         * Sign in when the app is opened, which is the one moment a person expects to be
         * asked. Nothing below works without a session, so there is nothing to show first.
         */
        if (!Prefs(this).isSignedIn) {
            startActivity(
                Intent(this, SignInActivity::class.java)
                    .putExtra(SignInActivity.EXTRA_THEN_LAUNCH, true),
            )
            finish()
            return
        }

        consume(intent)
        setContent {
            UnbentTheme {
                App(
                    requestedNote = requestedNote,
                    requestedSettings = requestedSettings,
                    onRequestConsumed = {
                        requestedNote = null
                        requestedSettings = false
                    },
                    onSignedOut = ::signOutAndRestart,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consume(intent)
    }

    private fun consume(intent: Intent?) {
        intent?.getStringExtra(EXTRA_NOTE_ID)?.let { requestedNote = it }
        if (intent?.action == ACTION_SETTINGS) requestedSettings = true
    }

    /**
     * Back to sign-in, whether the user chose to leave or the server stopped knowing them.
     *
     * The WebView's jar is cleared too: a stale cookie there would let the editor page keep
     * working for a while on a session the app itself has forgotten.
     */
    private fun signOutAndRestart() {
        Prefs(this).clearSession()
        WebSession.clear()
        startActivity(
            Intent(this, SignInActivity::class.java)
                .putExtra(SignInActivity.EXTRA_THEN_LAUNCH, true),
        )
        finish()
    }

    companion object {
        const val EXTRA_NOTE_ID = "noteId"
        const val ACTION_SETTINGS = "app.unbent.android.SETTINGS"

        /** An intent that opens the app on one note. Used by the capture notification. */
        fun openNote(context: Context, noteId: String): Intent =
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_NOTE_ID, noteId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

/**
 * The navigation host. Three destinations; the note takes its id from the route so a
 * back stack entry means one note, and returning to the list is a pop rather than a
 * navigation that would need to know where it came from.
 */
@Composable
private fun App(
    requestedNote: String?,
    requestedSettings: Boolean,
    onRequestConsumed: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val nav = rememberNavController()
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { Prefs(context) }
    val api = remember { UnbentApi(prefs.instance, prefs.session?.bearer) }

    LaunchedEffect(requestedNote, requestedSettings) {
        if (requestedNote != null) {
            nav.navigate("note/$requestedNote") { launchSingleTop = true }
            onRequestConsumed()
        } else if (requestedSettings) {
            nav.navigate("settings") { launchSingleTop = true }
            onRequestConsumed()
        }
    }

    NavHost(navController = nav, startDestination = "notes") {
        composable("notes") {
            NotesScreen(
                api = api,
                onOpen = { id -> nav.navigate("note/$id") },
                onOpenNew = { id -> nav.navigate("note/$id?new=true") },
                onSettings = { nav.navigate("settings") },
                onUnauthorized = onSignedOut,
            )
        }
        composable(
            "note/{id}?new={new}",
            arguments = listOf(
                navArgument("id") { type = NavType.StringType },
                navArgument("new") {
                    type = NavType.BoolType
                    defaultValue = false
                },
            ),
        ) { entry ->
            NoteScreen(
                noteId = entry.arguments?.getString("id").orEmpty(),
                focusTitle = entry.arguments?.getBoolean("new") ?: false,
                api = api,
                prefs = prefs,
                onBack = { nav.popBackStack() },
                onUnauthorized = onSignedOut,
            )
        }
        composable("settings") {
            SettingsScreen(
                api = api,
                prefs = prefs,
                onBack = { nav.popBackStack() },
                onSignedOut = onSignedOut,
            )
        }
    }
}
