package com.makerocketgonow.unbent.share

import com.makerocketgonow.unbent.api.ApiJson
import java.io.File
import kotlinx.serialization.Serializable
import java.util.UUID

/**
 * Makes a capture's WorkManager retries safe to run again.
 *
 * [UploadWorker] creates the note, then uploads files, then reports success. A dropped
 * radio in the middle is ordinary on a phone, and WorkManager retries the whole job,
 * which, without this, called `createNote` again and left a second, often empty, note
 * beside the first. Indexing is already a separate job for the same reason (see
 * [IndexWorker]); this is that property for the upload job's own retries.
 *
 * The note id is written into the staging directory as soon as the note exists, so a
 * retry finds it there. Filenames already on the note are skipped: an upload that the
 * server accepted but whose response never arrived would otherwise be sent again, and
 * `link=1` would append a second copy of the same file into the body.
 *
 * The sidecars start with a dot because a shared filename is sanitised to strip a leading
 * dot, so they cannot collide with a file this job is about to upload.
 */
object CaptureResume {

    private const val NOTE_ID_FILE = ".note-id"
    private const val CHOSEN_ID_FILE = ".chosen-id"
    private const val UNAVAILABLE_FILE = ".unavailable"
    private const val JOB_FILE = ".job"
    private const val REFUSED_FILE = ".refused"

    fun readNoteId(dir: File): String? =
        File(dir, NOTE_ID_FILE).takeIf { it.isFile }?.readText()?.trim()?.takeIf { it.isNotEmpty() }

    fun writeNoteId(dir: File, noteId: String) {
        dir.mkdirs()
        File(dir, NOTE_ID_FILE).writeText(noteId)
    }

    /**
     * The id a capture's note will have, chosen here before the request that makes it and
     * kept so every attempt sends the same one.
     *
     * Apart from [readNoteId] on purpose: that sidecar means the note exists on the server,
     * and a retry that finds it skips the create. This one means only that an id was
     * picked. The server answers a create or a clip carrying an id it already holds with
     * that note, so an attempt whose answer was lost finds the note the first one made
     * instead of making a second. The clip needs it most: without it a lost answer fetched
     * the page again and left two copies, pictures and all. A lowercase UUID, which is the
     * form the server's `uuid()` check accepts.
     */
    fun chosenNoteId(dir: File): String {
        val file = File(dir, CHOSEN_ID_FILE)
        file.takeIf { it.isFile }?.readText()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val id = UUID.randomUUID().toString()
        dir.mkdirs()
        file.writeText(id)
        return id
    }

    /**
     * How many earlier attempts the server turned away with a 503, which [UploadWorker]
     * does not count against its attempts. WorkManager's own count includes them and has
     * no way to be told otherwise, so the worker keeps this beside the note id and
     * subtracts it.
     */
    fun unavailableAttempts(dir: File): Int =
        File(dir, UNAVAILABLE_FILE).takeIf { it.isFile }?.readText()?.trim()?.toIntOrNull() ?: 0

    /** Counts one more attempt turned away, and returns the new total. */
    fun recordUnavailable(dir: File): Int {
        val count = unavailableAttempts(dir) + 1
        dir.mkdirs()
        File(dir, UNAVAILABLE_FILE).writeText(count.toString())
        return count
    }

    /**
     * Keeps a capture the plan refused ([CaptureRefusal]), so it can be sent again once
     * there is room for it.
     *
     * Everything else a capture is lives in WorkManager's input data, which goes with
     * the job when the worker fails, and a refused job has to fail: there is no telling
     * WorkManager "again when the person has subscribed", and a retry on its backoff
     * asks a lapsed account the same question for a day and then gives up. So the input
     * is written here beside the staged files ([job] is `Data.toByteArray()`, opaque to
     * this class so it stays testable without WorkManager), and `CaptureWork` starts a
     * new job from it when the app is next opened or something else is shared.
     *
     * The marker beside it is the capture's record while it waits ([KeptCapture]). The
     * 503 count is cleared, because it is subtracted from a run count that starts again
     * at nought in the new job.
     */
    fun keepRefused(dir: File, job: ByteArray, kept: KeptCapture) {
        dir.mkdirs()
        File(dir, JOB_FILE).writeBytes(job)
        File(dir, REFUSED_FILE).writeText(ApiJson.encodeToString(KeptCapture.serializer(), kept))
        File(dir, UNAVAILABLE_FILE).delete()
    }

    /** Marks a kept capture as looked after just now, for [Staging.sweepAbandoned]. */
    fun touch(dir: File) {
        File(dir, REFUSED_FILE).setLastModified(System.currentTimeMillis())
    }

    /** What the marker says of a kept capture; null when it is not one, or cannot be read. */
    fun kept(dir: File): KeptCapture? = runCatching {
        ApiJson.decodeFromString(KeptCapture.serializer(), File(dir, REFUSED_FILE).readText())
    }.getOrNull()

    /** Whether the plan refused this capture on an earlier attempt, and it was kept. */
    fun wasRefused(dir: File): Boolean = File(dir, REFUSED_FILE).isFile

    /** A kept capture's input, as [keepRefused] was given it; null when it is not one. */
    fun refusedJob(dir: File): ByteArray? =
        if (wasRefused(dir)) File(dir, JOB_FILE).takeIf { it.isFile }?.readBytes() else null

    /** Staged names that are not already attached to the note. */
    fun pendingFilenames(staged: Array<String>, alreadyOnNote: Collection<String>): List<String> {
        val have = alreadyOnNote.toSet()
        return staged.filter { it !in have }
    }
}

/**
 * What is known of a capture the plan refused, for as long as the phone keeps it: the
 * `.refused` marker's contents.
 *
 * A capture has no instance and no account of its own. The worker sends to whichever
 * instance the app is pointed at when it runs, as whoever is signed in then, which is
 * where and as whom it was shared for the minutes a capture used to last. A kept one
 * waits up to a month, through a sign-out and an address changed in App settings, so
 * both are written here and a resend goes only to that instance and only as that
 * account: sent as someone else, a scan would become a note in the wrong library, or be
 * asked of a note the new account does not own. [account] is the user id `/api/me`
 * answers, and null when that could not be asked at the refusal; a capture with none is
 * sent to whoever is signed in on its instance, which is what every capture did before.
 */
@Serializable
data class KeptCapture(
    /** A [CaptureRefusal]'s name. */
    val refusal: String,
    val instance: String,
    val account: String? = null,
    /** When it was last refused, which the wait before asking again counts from. */
    val at: Long = 0,
    /** How many times it has been refused, which that wait grows with (`CaptureWork.quietMs`). */
    val count: Int = 1,
    /** When it was first refused, which how long it is kept counts from ([expired]). */
    val since: Long = at,
) {
    /**
     * Whether a capture refused again at [now] has been kept long enough: thirty days
     * from its first refusal. Long enough to subscribe, or to delete down to the free
     * plan, without the scan that prompted it having gone; not for good, since each
     * asking costs the server a request and a kept scan costs the phone its size.
     *
     * Decided at a refusal, never by a sweep: the capture's last act is then an asking
     * that was refused, rather than being deleted on the very opening of the app that
     * was to have sent it. The iOS app's half is `CaptureJob.keptLongEnough`.
     */
    fun expired(now: Long): Boolean = now - since > KEPT_MS

    companion object {
        const val KEPT_MS = 30 * 24 * 60 * 60 * 1000L
    }
}
