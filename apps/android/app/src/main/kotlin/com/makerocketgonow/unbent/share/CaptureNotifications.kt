package com.makerocketgonow.unbent.share

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.ui.MainActivity
import com.makerocketgonow.unbent.ui.SignInActivity

/**
 * The one notification a capture has, from Save to the note it became.
 *
 * A toast cannot be tapped and cannot change its mind, and the sheet that showed it is
 * gone before the upload has started. So a capture's status lives in the shade:
 * "Saving…" the moment Save is tapped, replaced in place — one id per capture — by
 * "Saved" naming the note, which peeks down over whatever is on screen and opens the
 * note when tapped. The share sheet posts the first and the worker the rest; because
 * they share the id, neither needs to know what the other did. The sheet still shows a
 * toast as it closes, for the word on screen at the moment of the tap.
 */
object CaptureNotifications {

    private const val CHANNEL = "capture-status"

    fun createChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        /*
         * High importance is what lets "Saved" peek down over the screen for a moment:
         * that peek is the way to the note straight after sharing, without a trip to the
         * shade. At low importance it arrived in the shade without a sound, which read
         * as the capture never having finished. "Saving…" is posted silent, so the peek
         * happens once, when there is a note to open.
         */
        val channel = NotificationChannel(
            CHANNEL,
            context.getString(R.string.channel_captures),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply { description = context.getString(R.string.channel_captures_desc) }
        manager.createNotificationChannel(channel)
        /*
         * The channels this one replaced. A channel's importance is the user's once it
         * exists, and Android restores a deleted channel's settings if its id returns, so
         * each raise has been a new id and the old one going.
         */
        manager.deleteNotificationChannel("uploads")
        manager.deleteNotificationChannel("captures")
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
