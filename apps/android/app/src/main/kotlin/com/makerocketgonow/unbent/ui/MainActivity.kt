package com.makerocketgonow.unbent.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.UnbentTheme

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
        const val ACTION_SETTINGS = "com.makerocketgonow.unbent.SETTINGS"

        /** An intent that opens the app on one note. Used by the capture notification. */
        fun openNote(context: Context, noteId: String): Intent =
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_NOTE_ID, noteId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

/**
 * Saves the note list's filter into the instance state, and puts it back.
 *
 * A `listSaver` rather than a Parcelable, because what is being saved is five plain values
 * and a Parcelable would be a class definition and a lot of ceremony to carry them. Nulls
 * ride as empty strings: a bundle list holds them fine, but keeping the shape uniform means
 * the restore side has one rule rather than one per field.
 *
 * The state is rebuilt around the same api client it had, which is why this is a function
 * rather than a value — the client is not saveable and does not need to be, since it is
 * reconstructed from prefs on the way up.
 */
private fun NotesStateSaver(api: UnbentApi): Saver<NotesState, Any> = listSaver(
    save = { state ->
        val saved = state.save()
        // The tag list is last so it can be any length without the fixed fields moving.
        listOf(
            saved.notebook.orEmpty(),
            saved.sort,
            saved.from.orEmpty(),
            saved.to.orEmpty(),
        ) + saved.tags
    },
    restore = { values: List<String> ->
        NotesState(api).apply {
            restore(
                NotesState.Saved(
                    notebook = values[0].ifEmpty { null },
                    sort = values[1],
                    from = values[2].ifEmpty { null },
                    to = values[3].ifEmpty { null },
                    tags = values.drop(4),
                ),
            )
        }
    },
)

/** Whether a back stack entry is a note, which is the one destination with a direction. */
private val NavBackStackEntry.isNote: Boolean
    get() = destination.route?.startsWith("note/") == true

/**
 * The navigation host. The note takes its id from the route so a back stack entry means
 * one note, and returning to the list is a pop rather than a navigation that would need to
 * know where it came from.
 */
@Composable
private fun App(
    requestedNote: String?,
    requestedSettings: Boolean,
    onRequestConsumed: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val nav = rememberNavController()
    /** Set when another screen changed something the note list is showing. */
    var listStale by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { Prefs(context) }
    val api = remember { UnbentApi(prefs.instance, prefs.session?.bearer) }

    /*
     * The note list's state and its scroll live here rather than inside the destination.
     *
     * A NavHost takes a destination out of composition when it navigates away, so anything
     * remembered inside `composable("notes")` is destroyed the moment a note is opened and
     * rebuilt empty on the way back. That threw away the filter, the sort, the search and
     * however far the list had been scrolled: you narrowed to a notebook, read one note,
     * and came back to the top of everything having to do it again. Owned here, the list
     * is where it was left.
     *
     * Saved as well as remembered, so the filter also survives the process being killed
     * while the app sits in the background — which for a phone is an ordinary thing to
     * happen between putting it down and picking it up, not an edge case. Only the filter
     * is saved; see [NotesState.Saved] for what is left to reload and why.
     */
    val notes = rememberSaveable(api, saver = NotesStateSaver(api)) { NotesState(api) }
    val notesScroll = rememberLazyListState()

    LaunchedEffect(requestedNote, requestedSettings) {
        if (requestedNote != null) {
            nav.navigate("note/$requestedNote") { launchSingleTop = true }
            onRequestConsumed()
        } else if (requestedSettings) {
            nav.navigate("settings") { launchSingleTop = true }
            onRequestConsumed()
        }
    }

    /*
     * How screens arrive.
     *
     * The host's default is Material's fade-through: the old screen fades out, the new
     * one fades in while settling from slightly smaller. It is the motion for a sibling
     * — Settings, the Trash, the notebooks screen are places beside the list, not inside
     * it. A note is different: it is the thing that was tapped, opened, so it takes the
     * shared-axis slide below, which gives the tap a direction and gives Back the same
     * direction reversed. Keep grows the tapped card into the note; that container
     * transform is not worth it here because the note's body is a WebView that arrives
     * blank, so the card would morph into nothing. The slide lands on a screen that is
     * already drawing its own chrome.
     *
     * The timings are the spec's: 300ms for the slide, a 90ms fade out and a 210ms fade
     * in that starts as the fade out ends, so the two screens never sit fully lit on top
     * of each other. Defined once here rather than per route.
     */
    val shortcut = 30.dp
    val slide = with(LocalDensity.current) { shortcut.roundToPx() }
    val fadeOut = fadeOut(tween(90))
    val fadeIn = fadeIn(tween(210, delayMillis = 90))
    val slideSpec = tween<IntOffset>(300, easing = FastOutSlowInEasing)

    // Shared axis X: the incoming screen slides in from the end edge, the outgoing one
    // slides a little toward the start; Back runs the same thing mirrored.
    val enterNote: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition =
        { slideInHorizontally(slideSpec) { slide } + fadeIn }
    val exitForNote: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition =
        { slideOutHorizontally(slideSpec) { -slide } + fadeOut }
    val popEnterFromNote: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition =
        { slideInHorizontally(slideSpec) { -slide } + fadeIn }
    val popExitNote: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition =
        { slideOutHorizontally(slideSpec) { slide } + fadeOut }

    NavHost(
        navController = nav,
        startDestination = "notes",
        enterTransition = { fadeIn + scaleIn(tween(210, delayMillis = 90), initialScale = 0.92f) },
        exitTransition = { fadeOut },
        popEnterTransition = { fadeIn + scaleIn(tween(210, delayMillis = 90), initialScale = 0.92f) },
        popExitTransition = { fadeOut },
    ) {
        composable(
            "notes",
            // The list's side of opening a note, and of coming back from one. Only for a
            // note: its other neighbours are siblings and take the host's fade-through.
            exitTransition = { if (targetState.isNote) exitForNote() else fadeOut },
            popEnterTransition = {
                if (initialState.isNote) popEnterFromNote()
                else fadeIn + scaleIn(tween(210, delayMillis = 90), initialScale = 0.92f)
            },
        ) {
            NotesScreen(
                state = notes,
                listState = notesScroll,
                refreshKey = listStale,
                onRefreshed = { listStale = false },
                onOpen = { id -> nav.navigate("note/$id") },
                onOpenNew = { id -> nav.navigate("note/$id?new=true") },
                onSettings = { nav.navigate("settings") },
                onManageNotebooks = { creating -> nav.navigate("notebooks?creating=$creating") },
                onTrash = { nav.navigate("trash") },
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
            enterTransition = enterNote,
            popExitTransition = popExitNote,
        ) { entry ->
            NoteScreen(
                noteId = entry.arguments?.getString("id").orEmpty(),
                focusTitle = entry.arguments?.getBoolean("new") ?: false,
                api = api,
                prefs = prefs,
                /*
                 * The list keeps its place now, which means it also keeps whatever it
                 * knew before this note was opened — including the title and excerpt that
                 * were just edited. It used to reload by being rebuilt from nothing; now
                 * it has to be told.
                 */
                onBack = {
                    listStale = true
                    nav.popBackStack()
                },
                onUnauthorized = onSignedOut,
            )
        }
        composable(
            "notebooks?creating={creating}",
            arguments = listOf(
                navArgument("creating") {
                    type = NavType.BoolType
                    defaultValue = false
                },
            ),
        ) { entry ->
            ManageNotebooksScreen(
                api = api,
                focusCreate = entry.arguments?.getBoolean("creating") ?: false,
                /*
                 * The list behind this screen keeps its state while this one is on top —
                 * it is a navigation within one activity, so nothing about coming back
                 * reloads it on its own. A notebook renamed here would still show its old
                 * name in the drawer, and a deleted one would still be listed, until
                 * something else happened to refresh. Saying so on the way out is cheaper
                 * than making the list watch for changes it cannot see.
                 */
                onBack = {
                    listStale = true
                    nav.popBackStack()
                },
                onUnauthorized = onSignedOut,
            )
        }
        composable("trash") {
            TrashScreen(
                api = api,
                // Restoring or purging changes what the list behind is showing, the same
                // way a rename does; see the notebooks screen for why it must say so.
                onBack = {
                    listStale = true
                    nav.popBackStack()
                },
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
