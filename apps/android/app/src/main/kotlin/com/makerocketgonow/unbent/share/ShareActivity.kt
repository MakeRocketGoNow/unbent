package com.makerocketgonow.unbent.share

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.work.Data
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.CaptureSheet
import com.makerocketgonow.unbent.ui.SignInActivity
import com.makerocketgonow.unbent.ui.theme.UnbentTheme
import java.util.UUID
import kotlin.concurrent.thread

/**
 * The share-sheet entry point: a sheet over the sending app, then a background upload.
 *
 * The shared bytes are copied into the app's cache the moment this starts, before the
 * sheet has even drawn, because the URI permissions granted with a share are tied to this
 * activity and die with it. Everything after that (naming, filing, and the upload itself)
 * depends on nothing but that copy, so the sending app can go away, and a person who
 * has to sign in first can leave and come back.
 *
 * Save enqueues the upload and leaves. The sheet never waits for bytes to travel: a phone
 * radio is slow, and the notification says when the note has landed.
 */
class ShareActivity : ComponentActivity() {

    private val jobId = UUID.randomUUID().toString()

    /** The files, once copied. Null until then, which is what keeps Save disabled. */
    private var staged by mutableStateOf<List<StagedFile>?>(null)
    private var title by mutableStateOf("")
    private var signedIn by mutableStateOf(false)
    private var text = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val uris = extractUris(intent)
        text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)

        if (uris.isEmpty() && text.isEmpty()) {
            Toast.makeText(this, R.string.nothing_to_share, Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        /*
         * Which app this came from, for the title. `referrer` is the sending package when
         * the share sheet supplies one; its label is what the user would recognise
         * ("Photos", not "com.google.android.apps.photos").
         */
        val sourceApp = referrer?.host?.let { pkg ->
            runCatching {
                packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
            }.getOrNull()
        }

        /*
         * Staging touches the disk, so it cannot run on the main thread, and it must not be
         * tied to this activity's lifetime in case the sheet is dismissed mid-copy. It runs
         * against the application context and reports back to the screen when done.
         */
        val appContext = applicationContext
        thread {
            val files = Staging.stageAll(appContext, uris, jobId)
            val derived = Staging.deriveTitle(subject, files, text, sourceApp)
            runOnUiThread {
                staged = files
                title = derived
            }
        }

        val prefs = Prefs(this)
        signedIn = prefs.isSignedIn

        setContent {
            UnbentTheme {
                val api = remember(signedIn) {
                    if (signedIn) UnbentApi(prefs.instance, prefs.session?.bearer) else null
                }
                CaptureSheet(
                    api = api,
                    staged = staged,
                    hasText = text.isNotEmpty(),
                    isLink = UploadWorker.lonePageUrl(text) != null,
                    initialTitle = title,
                    lastNotebook = prefs.lastNotebook,
                    onSignIn = { startActivity(Intent(this, SignInActivity::class.java)) },
                    onSave = ::save,
                    onDismiss = ::cancel,
                )
            }
        }
    }

    /** Back from sign-in, or from anywhere: the sheet shows the form if there is a session now. */
    override fun onResume() {
        super.onResume()
        signedIn = Prefs(this).isSignedIn
    }

    private fun save(typed: String, notebook: String?, tags: List<String>) {
        val files = staged ?: return
        // A title cleared by hand gets the derived one back, as the iOS sheet does: otherwise
        // an empty title counts as typed, and it beats the page's own on a clip.
        val title = typed.ifEmpty { this.title }
        Prefs(this).lastNotebook = notebook

        CaptureWork.enqueue(
            applicationContext,
            Data.Builder()
                .putString(UploadWorker.KEY_JOB_ID, jobId)
                .putString(UploadWorker.KEY_TITLE, title)
                // Whether the title is the person's or the one staging derived: a
                // clipped page keeps its own title unless someone typed one over it.
                .putBoolean(UploadWorker.KEY_TITLE_TYPED, title != this.title)
                .putString(UploadWorker.KEY_BODY, text)
                .putString(UploadWorker.KEY_NOTEBOOK, notebook)
                .putStringArray(UploadWorker.KEY_TAGS, tags.toTypedArray())
                .putStringArray(UploadWorker.KEY_FILENAMES, files.map { it.filename }.toTypedArray())
                .putStringArray(UploadWorker.KEY_TYPES, files.map { it.contentType }.toTypedArray())
                .build(),
        )
        // A capture the plan refused earlier goes again with this one: someone sharing
        // again may well have made room since, and if not, each is told so once more.
        CaptureWork.resumeRefused(applicationContext)
        // The toast is the word on screen as the sheet closes; the notification is the
        // one that can turn into "Saved" and be tapped.
        Toast.makeText(this, R.string.saving, Toast.LENGTH_SHORT).show()
        CaptureNotifications.saving(this, jobId, title)
        finish()
    }

    /** Dismissed without saving: the copied files are not wanted, so they go. */
    private fun cancel() {
        val appContext = applicationContext
        val id = jobId
        thread { Staging.clear(appContext, id) }
        finish()
    }

    /** Both share shapes, normalized to a list. */
    private fun extractUris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(intent.parcelableExtra(Intent.EXTRA_STREAM))
        Intent.ACTION_SEND_MULTIPLE -> intent.parcelableArrayListExtra(Intent.EXTRA_STREAM)
        else -> emptyList()
    }

    @Suppress("DEPRECATION")
    private fun Intent.parcelableExtra(name: String): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(name, Uri::class.java)
        } else {
            getParcelableExtra(name)
        }

    @Suppress("DEPRECATION")
    private fun Intent.parcelableArrayListExtra(name: String): List<Uri> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableArrayListExtra(name, Uri::class.java).orEmpty()
        } else {
            getParcelableArrayListExtra<Uri>(name).orEmpty()
        }
}
