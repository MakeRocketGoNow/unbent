package app.unbent.android.share

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.unbent.android.Prefs
import app.unbent.android.R
import app.unbent.android.UnbentApp
import app.unbent.android.api.ApiException
import app.unbent.android.api.UnbentApi
import app.unbent.android.ui.LaunchActivity
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

        val prefs = Prefs(applicationContext)
        val token = prefs.token
        if (token.isNullOrEmpty()) {
            /*
             * No session. This should not happen in normal use — opening the app signs it
             * in — but it can if someone shares to a freshly installed app they have never
             * opened.
             *
             * The staged files are kept and the job waits, so the share is not lost while
             * the user deals with the notification. Nothing is launched from here: throwing
             * a sign-in screen over whatever they are doing is the interruption this whole
             * change exists to remove.
             */
            notify(applicationContext.getString(R.string.sign_in_needed), signInIntent())
            val arrived = awaitToken(prefs)
            if (arrived == null) {
                Staging.clear(applicationContext, jobId)
                return@withContext Result.failure()
            }
        }

        val api = UnbentApi(prefs.instance, prefs.token ?: return@withContext Result.failure())
        val dir = Staging.jobDir(applicationContext, jobId)

        try {
            val noteId = api.createNote(title, body)

            names.forEachIndexed { i, name ->
                val file = File(dir, name)
                // A file missing from the cache cannot be recovered by retrying; skip it
                // rather than failing the whole capture and losing the others.
                if (file.exists()) {
                    api.uploadFile(noteId, file, name, types.getOrElse(i) { "application/octet-stream" })
                }
            }

            Staging.clear(applicationContext, jobId)
            notify(
                applicationContext.getString(R.string.saved),
                openNoteIntent(prefs.instance, noteId),
            )
            Result.success()
        } catch (e: ApiException) {
            if (e.status == 401) {
                // The session is gone, not merely unreachable. Retrying cannot fix it, and
                // the stale token would keep failing silently on every later share.
                prefs.clearToken()
                Staging.clear(applicationContext, jobId)
                notify(applicationContext.getString(R.string.sign_in_needed), signInIntent())
                Result.failure()
            } else if (runAttemptCount < MAX_ATTEMPTS) {
                Result.retry()
            } else {
                Staging.clear(applicationContext, jobId)
                notify(applicationContext.getString(R.string.save_failed), null)
                Result.failure()
            }
        } catch (e: Exception) {
            if (runAttemptCount < MAX_ATTEMPTS) {
                Result.retry()
            } else {
                Staging.clear(applicationContext, jobId)
                notify(applicationContext.getString(R.string.save_failed), null)
                Result.failure()
            }
        }
    }

    private fun openNoteIntent(origin: String, noteId: String): PendingIntent {
        val intent = Intent(applicationContext, LaunchActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(LaunchActivity.EXTRA_URL, "$origin/notes/$noteId")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            applicationContext,
            noteId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun signInIntent(): PendingIntent {
        val intent = Intent(applicationContext, app.unbent.android.ui.SettingsActivity::class.java)
            .apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
        return PendingIntent.getActivity(
            applicationContext,
            1,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Polls for a session while the user connects, up to [CONNECT_WAIT_MS].
     *
     * A poll rather than a callback because the token is written by another activity in
     * this same process, and a broadcast or an observer would be more machinery than a
     * one-second check for something a person is doing by hand. Returns null on timeout.
     */
    private suspend fun awaitToken(prefs: Prefs): String? {
        val deadline = System.currentTimeMillis() + CONNECT_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            delay(1_000)
            val token = prefs.token
            if (!token.isNullOrEmpty()) return token
        }
        return null
    }

    private fun notify(text: String, tapAction: PendingIntent?) {
        val manager = applicationContext.getSystemService(NotificationManager::class.java) ?: return
        val notification = NotificationCompat.Builder(applicationContext, UnbentApp.CHANNEL_UPLOADS)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(applicationContext.getString(R.string.app_name))
            .setContentText(text)
            .setAutoCancel(true)
            .apply { tapAction?.let { setContentIntent(it) } }
            .build()
        // POST_NOTIFICATIONS may be denied; the upload still succeeded, so swallow it.
        runCatching { manager.notify(id.hashCode(), notification) }
    }

    companion object {
        const val KEY_JOB_ID = "jobId"
        const val KEY_TITLE = "title"
        const val KEY_BODY = "body"
        const val KEY_FILENAMES = "filenames"
        const val KEY_TYPES = "types"
        private const val MAX_ATTEMPTS = 4

        /** How long a capture waits for the user to finish connecting. */
        private const val CONNECT_WAIT_MS = 5 * 60 * 1000L
    }
}
