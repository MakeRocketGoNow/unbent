package app.unbent.android.share

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.unbent.android.Prefs
import app.unbent.android.api.ApiException
import app.unbent.android.api.UnbentApi
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Creates the note and uploads the staged files.
 *
 * A worker rather than work on the share activity's thread: the share sheet should close
 * the instant the files are staged, and an upload over a phone radio outlives the activity
 * that started it. WorkManager also gives retries and a network constraint for free.
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val jobId = inputData.getString(KEY_JOB_ID) ?: return@withContext Result.failure()
        val title = inputData.getString(KEY_TITLE).orEmpty()
        val body = inputData.getString(KEY_BODY).orEmpty()
        val names = inputData.getStringArray(KEY_FILENAMES).orEmpty()
        val types = inputData.getStringArray(KEY_TYPES).orEmpty()
        val notebook = inputData.getString(KEY_NOTEBOOK)
        val tags = inputData.getStringArray(KEY_TAGS).orEmpty().toList()
        val context = applicationContext

        CaptureNotifications.saving(context, jobId, title)

        val prefs = Prefs(context)
        if (!prefs.isSignedIn) {
            /*
             * No session yet. ShareActivity has already opened the sign-in screen — it can,
             * being foreground at the time; a worker can run at any moment and must not
             * throw a screen over whatever the user is doing.
             *
             * So this simply waits for the token that sign-in is about to write, and the
             * capture completes on its own. The staged files sit on disk meanwhile, so
             * nothing is lost if it takes the user a while.
             */
            if (!awaitSession(prefs)) {
                // Gave up, or never finished signing in. Say so rather than dropping it
                // silently — the user shared something and deserves to know it did not land.
                CaptureNotifications.signInNeeded(context, jobId, title)
                Staging.clear(context, jobId)
                return@withContext Result.failure()
            }
        }

        val api = UnbentApi(prefs.instance, prefs.session?.bearer ?: return@withContext Result.failure())
        val dir = Staging.jobDir(context, jobId)

        try {
            val noteId = api.createNote(title, body, tags, notebook).id

            names.forEachIndexed { i, name ->
                val file = File(dir, name)
                // A file missing from the cache cannot be recovered by retrying; skip it
                // rather than failing the whole capture and losing the others.
                if (file.exists()) {
                    api.uploadFile(noteId, file, name, types.getOrElse(i) { "application/octet-stream" })
                }
            }

            Staging.clear(context, jobId)

            CaptureNotifications.saved(context, jobId, title, noteId)
            // The note's id is this job's output, for the indexing job chained after it.
            Result.success(workDataOf(KEY_NOTE_ID to noteId))
        } catch (e: ApiException) {
            if (e.status == 401) {
                // The session is gone, not merely unreachable. Retrying cannot fix it, and
                // the stale token would keep failing silently on every later share.
                prefs.clearSession()
                Staging.clear(context, jobId)
                CaptureNotifications.signInNeeded(context, jobId, title)
                Result.failure()
            } else if (runAttemptCount < MAX_ATTEMPTS) {
                Result.retry()
            } else {
                Staging.clear(context, jobId)
                CaptureNotifications.failed(context, jobId, title)
                Result.failure()
            }
        } catch (e: Exception) {
            if (runAttemptCount < MAX_ATTEMPTS) {
                Result.retry()
            } else {
                Staging.clear(context, jobId)
                CaptureNotifications.failed(context, jobId, title)
                Result.failure()
            }
        }
    }

    /**
     * Polls for a session while the user connects, up to [CONNECT_WAIT_MS].
     *
     * A poll rather than a callback because the session is written by another activity in
     * this same process, and a broadcast or an observer would be more machinery than a
     * one-second check for something a person is doing by hand. False on timeout.
     */
    private suspend fun awaitSession(prefs: Prefs): Boolean {
        val deadline = System.currentTimeMillis() + CONNECT_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            delay(1_000)
            if (prefs.isSignedIn) return true
        }
        return false
    }

    companion object {
        const val KEY_JOB_ID = "jobId"
        const val KEY_TITLE = "title"
        const val KEY_BODY = "body"
        const val KEY_FILENAMES = "filenames"
        const val KEY_TYPES = "types"
        /** Null means the Inbox. */
        const val KEY_NOTEBOOK = "notebook"
        const val KEY_TAGS = "tags"
        /** Output: the note this capture became. */
        const val KEY_NOTE_ID = "noteId"
        private const val MAX_ATTEMPTS = 4

        /** How long a capture waits for the user to finish connecting. */
        private const val CONNECT_WAIT_MS = 5 * 60 * 1000L
    }
}
