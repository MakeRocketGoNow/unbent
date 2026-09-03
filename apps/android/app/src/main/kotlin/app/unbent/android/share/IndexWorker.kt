package app.unbent.android.share

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.unbent.android.Prefs
import app.unbent.android.ui.HeadlessIndexer

/**
 * Makes a capture's PDFs searchable, once they have landed.
 *
 * The upload streams bytes and nothing else, so a PDF shared from the phone used to sit
 * unindexed until someone pressed a button on the web. pdf.js is the extractor this
 * project has and it lives in the browser, so this job runs the site's own indexing page
 * in a WebView nobody sees — see [HeadlessIndexer] — for the one note the upload made.
 *
 * A job of its own, chained after [UploadWorker], rather than a phase of it: if the
 * WebView dies, the retry must not create the note again. Only the indexing is retried,
 * and only once.
 *
 * Every outcome but a retry is success, on purpose. The note and its files are saved;
 * a failure here would tell no one anything they could act on, and the file stays on
 * the server's pending list, where the web app's pass on open picks it up. An
 * `unauthorized` answer does not clear the app's session either — the upload seconds
 * earlier succeeded with the same cookie, so that is the WebView's problem, not a dead
 * session.
 */
class IndexWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val noteId = inputData.getString(UploadWorker.KEY_NOTE_ID) ?: return Result.success()
        // The server may have extracted the text itself as the files landed; then there is
        // nothing to spin a WebView up for. Absent means an older upload job: assume there is.
        if (!inputData.getBoolean(UploadWorker.KEY_NEEDS_INDEX, true)) return Result.success()
        val prefs = Prefs(applicationContext)
        val session = prefs.session ?: return Result.success()

        return when (HeadlessIndexer.index(applicationContext, prefs.instance, session, noteId, TIMEOUT_MS)) {
            is HeadlessIndexer.Outcome.Done, HeadlessIndexer.Outcome.Unauthorized -> Result.success()
            is HeadlessIndexer.Outcome.Failed, HeadlessIndexer.Outcome.TimedOut ->
                if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()
        }
    }

    companion object {
        /** Only a PDF has text to extract; a capture of photos never spins up a WebView. */
        fun needsIndexing(contentTypes: List<String>): Boolean =
            contentTypes.any { it == "application/pdf" }

        private const val MAX_ATTEMPTS = 2

        /**
         * Well under WorkManager's ten-minute cap on a job, and under the five minutes
         * after which Chromium throttles a hidden page hard. A hundred-page scan indexes
         * in seconds; anything still going at four minutes is not going to finish.
         */
        private const val TIMEOUT_MS = 4 * 60 * 1000L
    }
}
