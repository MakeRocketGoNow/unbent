package app.unbent.android.share

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.unbent.android.R
import app.unbent.android.ui.MainActivity
import app.unbent.android.ui.SignInActivity

/**
 * The one notification a capture has, from Save to the note it became.
 *
 * A toast cannot be tapped and cannot change its mind, and the sheet that showed it is
 * gone before the upload has started. So a capture's status lives in the shade instead:
 * "Saving…" the moment Save is tapped, replaced in place — one id per capture — by
 * "Saved" naming the note, and a tap on that opens the note. The share sheet posts the
 * first and the worker the rest; because they share the id, neither needs to know what
 * the other did.
 */
object CaptureNotifications {

    private const val CHANNEL = "captures"

    fun createChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        /*
         * Default importance: a capture landing deserves the one soft chime a finished
         * download gets, and no more. At low importance "Saved" arrived in the shade
         * without a sound, which read as the capture never having finished.
         */
        val channel = NotificationChannel(
            CHANNEL,
            context.getString(R.string.channel_captures),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = context.getString(R.string.channel_captures_desc) }
        manager.createNotificationChannel(channel)
        // The channel this one replaced. A channel's importance is fixed once created,
        // so raising it meant a new channel and the old one going.
        manager.deleteNotificationChannel("uploads")
    }

    /** Whether the user will see one at all. If not, the caller says what it can another way. */
    fun enabled(context: Context): Boolean {
        val compat = NotificationManagerCompat.from(context)
        if (!compat.areNotificationsEnabled()) return false
        val channel = compat.getNotificationChannel(CHANNEL) ?: return true
        return channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    /** Posted at Save, and again when the worker starts, in case the first was swiped away. */
    fun saving(context: Context, jobId: String, title: String) {
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle(context.getString(R.string.saving))
                .setProgress(0, 0, true)
                .setSilent(true)
                .setOnlyAlertOnce(true),
        )
    }

    fun saved(context: Context, jobId: String, title: String, noteId: String) {
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setContentTitle(context.getString(R.string.saved))
                .setContentIntent(openNote(context, noteId))
                .setAutoCancel(true),
        )
    }

    fun failed(context: Context, jobId: String, title: String) {
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(context.getString(R.string.save_failed))
                .setAutoCancel(true),
        )
    }

    fun signInNeeded(context: Context, jobId: String, title: String) {
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(context.getString(R.string.sign_in_needed))
                .setContentIntent(signIn(context))
                .setAutoCancel(true),
        )
    }

    /** The note's title is the second line throughout, so "Saved" says what was saved. */
    private fun builder(context: Context, title: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, CHANNEL)
            .setContentText(title.ifBlank { context.getString(R.string.untitled) })

    private fun post(context: Context, jobId: String, builder: NotificationCompat.Builder) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        // Notifications may be off; the capture itself is unaffected, so swallow it.
        runCatching { manager.notify(jobId.hashCode(), builder.build()) }
    }

    private fun openNote(context: Context, noteId: String): PendingIntent =
        PendingIntent.getActivity(
            context,
            noteId.hashCode(),
            MainActivity.openNote(context, noteId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun signIn(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            1,
            Intent(context, SignInActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}
