package app.unbent.android.share

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import app.unbent.android.Prefs
import app.unbent.android.R
import app.unbent.android.ui.SignInActivity
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The share-sheet entry point.
 *
 * Draws nothing and finishes as fast as it can: the user is in another app and wants the
 * sheet gone. All this does is copy the shared bytes somewhere durable and enqueue the
 * upload, because the URI permissions granted with a share die with this activity.
 */
class ShareActivity : AppCompatActivity() {

    /**
     * Registered unconditionally, as the Activity Result API requires — a launcher
     * registered inside a branch throws when the activity is recreated.
     */
    private val signIn = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (Prefs(this).isSignedIn) handleShare() else finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Prefs(this).isSignedIn) {
            // Hold the shared intent across sign-in rather than dropping it: the user
            // shared something, and losing it because they happened to be signed out is
            // their file gone for a reason they cannot see.
            signIn.launch(Intent(this, SignInActivity::class.java))
            return
        }

        handleShare()
    }

    private fun handleShare() {
        val uris = extractUris(intent)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)

        if (uris.isEmpty() && text.isEmpty()) {
            Toast.makeText(this, R.string.nothing_to_share, Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        val jobId = UUID.randomUUID().toString()
        Toast.makeText(this, R.string.saving, Toast.LENGTH_SHORT).show()

        /*
         * Staging touches the disk, so it cannot run on the main thread — but it also must
         * not be tied to this activity, which finishes immediately below. The work runs
         * against the application context and enqueues itself when done; nothing here reads
         * `this` afterwards, so the activity going away mid-copy is harmless.
         */
        val appContext = applicationContext
        thread {
            val staged = Staging.stageAll(appContext, uris, jobId)
            val title = Staging.deriveTitle(subject, staged)

            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setInputData(
                    Data.Builder()
                        .putString(UploadWorker.KEY_JOB_ID, jobId)
                        .putString(UploadWorker.KEY_TITLE, title)
                        .putString(UploadWorker.KEY_BODY, text)
                        .putStringArray(
                            UploadWorker.KEY_FILENAMES,
                            staged.map { it.filename }.toTypedArray(),
                        )
                        .putStringArray(
                            UploadWorker.KEY_TYPES,
                            staged.map { it.contentType }.toTypedArray(),
                        )
                        .build(),
                )
                .build()

            WorkManager.getInstance(appContext).enqueue(request)
        }

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
