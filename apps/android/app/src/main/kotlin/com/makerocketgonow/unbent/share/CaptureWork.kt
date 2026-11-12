package com.makerocketgonow.unbent.share

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.makerocketgonow.unbent.Prefs
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Starts a capture's jobs: at Save, and again for one the plan refused and the phone kept.
 *
 * One place for both so the second is the first, exactly: the same constraint, the same
 * backoff, the same indexing job chained after a PDF. A capture sent again from a copy of
 * this would drift from it the next time the share sheet's half changed.
 */
object CaptureWork {

    /**
     * Enqueues the upload for [input] (the keys are [UploadWorker]'s), and the indexing
     * job after it when a file needs one.
     *
     * Unique by capture, and an existing job is kept: [resumeRefused] is called every time
     * the app comes to the screen, and without the name a capture already going again
     * would be started once more for each, uploading its files side by side.
     */
    fun enqueue(context: Context, input: Data) {
        val jobId = input.getString(UploadWorker.KEY_JOB_ID) ?: return
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(input)
            .build()

        /*
         * A PDF gets a second job, chained after the upload, that makes its text
         * searchable. Chained rather than done inside the upload so that a WebView
         * failure in the second can never re-run the first and create the note twice;
         * photos have no text to extract and skip it, so no WebView spins up for a
         * screenshot.
         */
        val work = WorkManager.getInstance(context.applicationContext)
            .beginUniqueWork("capture-$jobId", ExistingWorkPolicy.KEEP, request)
        val types = input.getStringArray(UploadWorker.KEY_TYPES).orEmpty().toList()
        if (IndexWorker.needsIndexing(types)) {
            val index = OneTimeWorkRequestBuilder<IndexWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .build()
            work.then(index).enqueue()
        } else {
            work.enqueue()
        }
    }

    /**
     * Sends again every capture the plan refused ([CaptureRefusal]), from the input kept
     * beside its files. Called when the app comes to the screen and when something else
     * is shared; [UploadWorker] says why those and not a timer or a button.
     *
     * The marker is left where it is. The job this starts reads it to know it is a second
     * asking, and it goes with the directory when the capture lands or is given up on. A
     * job refused again rewrites it. Until then a call that finds the capture already
     * going is dropped by the unique name, so calling this often costs nothing.
     *
     * Off the main thread: it lists a directory and reads a small file per capture.
     */
    fun resumeRefused(context: Context) {
        val app = context.applicationContext
        thread {
            val prefs = Prefs(app)
            // Signed out, the worker waits five minutes for a sign-in and then clears
            // the capture and says to share again: right for a share just made, and the
            // loss of one the person was told is kept. It stays for the next sign-in.
            if (!prefs.isSignedIn) return@thread
            for (dir in Staging.jobDirs(app)) {
                val kept = CaptureResume.refusedJob(dir) ?: continue
                // Shared to another instance than the app is on now; see `KeptCapture`.
                // The account is the worker's to check, since it takes a request.
                val record = CaptureResume.kept(dir) ?: continue
                if (!sameInstance(record.instance, prefs.instance)) continue
                // A record this build cannot read is left for the sweep, not sent blind.
                val input = runCatching { Data.fromByteArray(kept) }.getOrNull() ?: continue
                val dear = CaptureResume.readNoteId(dir) != null || isClip(input)
                if (!resendsRefused(dear, record.at, System.currentTimeMillis())) continue
                enqueue(app, Data.Builder().putAll(input).putBoolean(UploadWorker.KEY_RESUMED, true).build())
            }
        }
    }

    /**
     * Whether a capture the plan refused is sent again now.
     *
     * A note that was refused is a few hundred bytes, and goes every time: someone back
     * from subscribing should not wait. Two captures cost more to ask about ([dear]). One
     * whose note exists was refused at a file, and uploads the whole file to hear the
     * answer, a scan of tens of megabytes over a phone connection; and a clip has the
     * server fetch and read someone else's page before the store refuses it. `onStart`
     * runs on every return to the app, from the camera and the file chooser included, so
     * those two wait [REFUSED_QUIET_MS] from their last refusal: long enough that a full
     * account is not uploading the same scan each time the phone is picked up, short
     * enough to pass while storage is added.
     *
     * Asking the server for the plan first was the other way. It answers a different
     * question for each of the four refusals (a state, a count of notes, two sizes of
     * room), and the write itself is the only check that is never out of step with the
     * rule it checks. The iOS app's half is `CaptureJob.resendsRefused`.
     */
    internal fun resendsRefused(dear: Boolean, refusedAt: Long?, now: Long): Boolean =
        // A refusal "in the future" is a clock that was set back, not a reason to wait
        // until the wall time catches up with it.
        !dear || refusedAt == null || now < refusedAt || now - refusedAt >= REFUSED_QUIET_MS

    /** Whether a capture kept for [kept] may be sent to [current], the instance the app is on. */
    internal fun sameInstance(kept: String?, current: String): Boolean =
        kept != null && Prefs.normalizeOrigin(kept) == Prefs.normalizeOrigin(current)

    /** Whether [input] is a share the worker will ask the server to read as a page. */
    private fun isClip(input: Data): Boolean =
        input.getStringArray(UploadWorker.KEY_FILENAMES).isNullOrEmpty() &&
            UploadWorker.lonePageUrl(input.getString(UploadWorker.KEY_BODY).orEmpty()) != null

    internal const val REFUSED_QUIET_MS = 15 * 60 * 1000L
}
