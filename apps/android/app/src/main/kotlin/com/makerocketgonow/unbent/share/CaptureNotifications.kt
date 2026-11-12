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
 * "Saving…" the moment Save is tapped, replaced in place (one id per capture) by
 * "Saved" naming the note, which peeks down over whatever is on screen and opens the
 * note when tapped. The share sheet posts the first and the worker the rest; because
 * they share the id, neither needs to know what the other did. The sheet still shows a
 * toast as it closes, for the word on screen at the moment of the tap.
 */
object CaptureNotifications {

    private const val CHANNEL = "capture-status"

    /** The site's Plan page, which has the numbers behind every refusal a capture is kept for. */
    private const val PLAN_PATH = "/settings/plan"

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

    /**
     * Replaces [saving] while a capture waits for the server to come back, which can be
     * hours (see [UploadWorker]). The saving notification's spinner, left up that long,
     * looks stuck; this has no progress bar and says what is happening instead. The next
     * attempt posts [saving] again over it, since that attempt is saving.
     */
    fun waiting(context: Context, jobId: String, title: String) {
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle(context.getString(R.string.save_waiting))
                .setSilent(true)
                .setOnlyAlertOnce(true),
        )
    }

    /**
     * [clipped] says the note is the shared page itself, read on the server, rather than
     * a note holding its link: the one word that tells a person which of the two they got
     * is the one the notification leads with. A link that fell back to the plain note is
     * "Saved", as before, and honestly so.
     */
    fun saved(context: Context, jobId: String, title: String, noteId: String, clipped: Boolean = false) {
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setContentTitle(context.getString(if (clipped) R.string.clipped else R.string.saved))
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

    /**
     * The plan would not take the capture, and it is kept on the phone ([CaptureRefusal]).
     *
     * The title names the room there is none of, short enough for a notification's first
     * line (`strings.xml` says why the first is the web app's "read-only"). A tap opens
     * the Plan page, which has the numbers for every one of these and says what to
     * delete. Inside the app that page draws no Subscribe or storage buttons (the stores'
     * billing rules; `isHosted` in the web app's `Plan.tsx`) and says to do those on the
     * web, so the notice promises a reason, not a checkout. The expanded text says the
     * one thing the person cannot see for themselves, which is that what they shared has
     * not been lost and needs no sharing again.
     *
     * [quiet] for a capture that was refused before and has been again: the first notice
     * peeks, and a repeat of it each time the app is opened would be nagging.
     */
    fun refused(context: Context, jobId: String, title: String, refusal: CaptureRefusal, quiet: Boolean = false) {
        val heading = when (refusal) {
            CaptureRefusal.PLAN_ENDED -> R.string.refused_plan_ended
            CaptureRefusal.FREE_NOTES_FULL -> R.string.refused_free_notes_full
            CaptureRefusal.STORAGE_FULL -> R.string.refused_storage_full
            CaptureRefusal.NOTES_FULL -> R.string.refused_notes_full
            CaptureRefusal.PLAN -> R.string.refused_plan
        }
        val named = title.ifBlank { context.getString(R.string.untitled) }
        // A repeat only brings the notice up to date; it does not bring it back. Someone
        // who swiped it away has read it, and a note that is refused on every return to
        // the app would put it in the shade again each time.
        if (quiet && !showing(context, jobId)) return
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(context.getString(heading))
                .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(R.string.refused_kept, named)))
                .setContentIntent(openPlan(context))
                .setSilent(quiet)
                .setAutoCancel(true),
        )
    }

    /**
     * [kept] for a capture that is still on the phone and goes when someone signs in (one
     * the plan had refused), which must not be told to share again; every other capture
     * has been cleared by the time this is posted.
     */
    fun signInNeeded(context: Context, jobId: String, title: String, kept: Boolean = false) {
        post(
            context, jobId,
            builder(context, title)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(context.getString(if (kept) R.string.sign_in_to_finish else R.string.sign_in_needed))
                .setContentIntent(signIn(context))
                .setAutoCancel(true),
        )
    }

    /** The note's title is the second line throughout, so "Saved" says what was saved. */
    private fun builder(context: Context, title: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, CHANNEL)
            .setContentText(title.ifBlank { context.getString(R.string.untitled) })

    private fun showing(context: Context, jobId: String): Boolean {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        return runCatching { manager.activeNotifications.any { it.id == jobId.hashCode() } }.getOrDefault(false)
    }

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

    /** One request code for every capture: they all open the same page. */
    private fun openPlan(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            2,
            MainActivity.openPath(context, PLAN_PATH),
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
