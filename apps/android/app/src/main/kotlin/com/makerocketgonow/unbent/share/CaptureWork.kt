package com.makerocketgonow.unbent.share

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
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
            for (dir in Staging.jobDirs(app)) {
                val kept = CaptureResume.refusedJob(dir) ?: continue
                // A record this build cannot read is left for the sweep, not sent blind.
                val input = runCatching { Data.fromByteArray(kept) }.getOrNull() ?: continue
                enqueue(app, input)
            }
        }
    }
}
