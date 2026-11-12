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
import java.io.File
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
    fun enqueue(context: Context, input: Data, delayMs: Long = 0) {
        val jobId = input.getString(UploadWorker.KEY_JOB_ID) ?: return
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(input)
            .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
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
            val now = System.currentTimeMillis()
            val waiting = Staging.jobDirs(app).mapNotNull { dir ->
                val kept = CaptureResume.refusedJob(dir) ?: return@mapNotNull null
                // Shared to another instance than the app is on now; see `KeptCapture`.
                // The account is the worker's to check, since it takes a request.
                val record = CaptureResume.kept(dir) ?: return@mapNotNull null
                if (!sameInstance(record.instance, prefs.instance)) return@mapNotNull null
                // A record this build cannot read is left for the sweep, not sent blind.
                val input = runCatching { Data.fromByteArray(kept) }.getOrNull() ?: return@mapNotNull null
                val dear = CaptureResume.readNoteId(dir) != null || isClip(input)
                Waiting(dir, input, record, refusedWaitMs(dear, record.at, record.count, now))
            }
            for (one in firstOfEach(waiting)) {
                // Touched, so the sweep (which goes by the newest file) counts from the
                // last time anything was done for this capture and cannot take it from
                // under the job being started here.
                CaptureResume.touch(one.dir)
                // Not skipped while it waits: enqueued for when the wait ends, so it
                // goes then without anyone having to open the app a second time. The
                // unique name drops every call that finds it already waiting.
                val input = one.input ?: continue
                enqueue(app, Data.Builder().putAll(input).putBoolean(UploadWorker.KEY_RESUMED, true).build(), one.waitMs)
            }
        }
    }

    /**
     * A kept capture that could be sent again, and how long it has still to wait first.
     * [input] is nullable only so a test can make one without WorkManager's `Data`.
     */
    internal class Waiting(val dir: File, val input: Data?, val record: KeptCapture, val waitMs: Long)

    /**
     * The captures to ask the server about: one for each reason captures were refused.
     *
     * A lapsed account that shared a dozen things has a dozen kept captures, and the
     * answer to the first is the answer to all of them: every return to the app was a
     * dozen jobs, a dozen requests each paying a call to the account's store to hear 402,
     * and a dozen notices posted again. So one goes, the one that can go soonest and
     * among those the longest kept, and [UploadWorker] calls back here when a kept
     * capture lands, which sends the next. By reason, because the reasons have different
     * answers: an account out of storage for files still takes a note.
     */
    internal fun firstOfEach(waiting: List<Waiting>): List<Waiting> =
        waiting.groupBy { it.record.refusal }.values.map { same ->
            same.minWith(compareBy<Waiting> { it.waitMs }.thenBy { it.record.since })
        }

    /**
     * How long a capture the plan refused waits before it is sent again: nothing for most,
     * and the rest of a quiet spell for the two that are dear to ask about.
     *
     * A note that was refused is a few hundred bytes, and goes every time: someone back
     * from subscribing should not wait. Two captures cost more ([dear]). One whose note
     * exists was refused at a file, and uploads the whole file to hear the answer, a scan
     * of tens of megabytes over a phone connection; and a clip has the server fetch and
     * read someone else's page before the store refuses it. `onStart` runs on every
     * return to the app, from the camera and the file chooser included, so those two
     * wait out [quietMs] from their last refusal first.
     *
     * Asking the server for the plan first was the other way. It answers a different
     * question for each of the four refusals (a state, a count of notes, two sizes of
     * room), and the write itself is the only check that is never out of step with the
     * rule it checks. The iOS app's half is `CaptureJob.refusedWait`.
     */
    internal fun refusedWaitMs(dear: Boolean, refusedAt: Long, count: Int, now: Long): Long =
        // A refusal "in the future" is a clock that was set back, not a reason to wait
        // until the wall time catches up with it.
        if (!dear || now < refusedAt) 0 else (refusedAt + quietMs(count) - now).coerceAtLeast(0)

    /**
     * The quiet spell after a capture's [count]th refusal: a quarter of an hour, doubling,
     * to six hours.
     *
     * A fixed quarter of an hour was first. It is right for the person adding storage,
     * who is back within it, and wrong for the account that simply stays full: that one
     * uploaded the same scan four times in every hour the app was in use, for as long as
     * it was used. Doubling leaves the first few askings close together and settles at
     * four a day.
     */
    internal fun quietMs(count: Int): Long =
        (REFUSED_QUIET_MS shl (count - 1).coerceIn(0, 16)).coerceAtMost(REFUSED_QUIET_MAX_MS)

    /** Whether a capture kept for [kept] may be sent to [current], the instance the app is on. */
    internal fun sameInstance(kept: String?, current: String): Boolean =
        kept != null && Prefs.normalizeOrigin(kept) == Prefs.normalizeOrigin(current)

    /** Whether [input] is a share the worker will ask the server to read as a page. */
    private fun isClip(input: Data): Boolean =
        input.getStringArray(UploadWorker.KEY_FILENAMES).isNullOrEmpty() &&
            UploadWorker.lonePageUrl(input.getString(UploadWorker.KEY_BODY).orEmpty()) != null

    internal const val REFUSED_QUIET_MS = 15 * 60 * 1000L
    internal const val REFUSED_QUIET_MAX_MS = 6 * 60 * 60 * 1000L
}
