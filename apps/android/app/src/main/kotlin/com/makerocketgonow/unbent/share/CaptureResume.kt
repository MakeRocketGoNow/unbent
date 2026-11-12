package com.makerocketgonow.unbent.share

import java.io.File
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
    internal const val REFUSED_FILE = ".refused"

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
     * The marker's time is the refusal's: rewritten on each, so [Staging.sweepAbandoned]
     * counts from the last time anyone was told. The 503 count is cleared, because it is
     * subtracted from a run count that starts again at nought in the new job.
     */
    fun keepRefused(dir: File, job: ByteArray, refusal: CaptureRefusal) {
        dir.mkdirs()
        File(dir, JOB_FILE).writeBytes(job)
        File(dir, REFUSED_FILE).writeText(refusal.name)
        File(dir, UNAVAILABLE_FILE).delete()
    }

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
