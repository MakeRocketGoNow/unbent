package com.makerocketgonow.unbent.share

import java.io.File

/**
 * Makes a capture's WorkManager retries safe to run again.
 *
 * [UploadWorker] creates the note, then uploads files, then reports success. A dropped
 * radio in the middle is ordinary on a phone, and WorkManager retries the whole job —
 * which, without this, called `createNote` again and left a second, often empty, note
 * beside the first. Indexing is already a separate job for the same reason (see
 * [IndexWorker]); this is that property for the upload job's own retries.
 *
 * The note id is written into the staging directory as soon as the note exists, so a
 * retry finds it there. Filenames already on the note are skipped: an upload that the
 * server accepted but whose response never arrived would otherwise be sent again, and
 * `link=1` would append a second copy of the same file into the body.
 *
 * The sidecar is `.note-id` because a shared filename is sanitised to strip a leading
 * dot, so it cannot collide with a file this job is about to upload.
 */
object CaptureResume {

    private const val NOTE_ID_FILE = ".note-id"

    fun readNoteId(dir: File): String? =
        File(dir, NOTE_ID_FILE).takeIf { it.isFile }?.readText()?.trim()?.takeIf { it.isNotEmpty() }

    fun writeNoteId(dir: File, noteId: String) {
        dir.mkdirs()
        File(dir, NOTE_ID_FILE).writeText(noteId)
    }

    /** Staged names that are not already attached to the note. */
    fun pendingFilenames(staged: Array<String>, alreadyOnNote: Collection<String>): List<String> {
        val have = alreadyOnNote.toSet()
        return staged.filter { it !in have }
    }
}
