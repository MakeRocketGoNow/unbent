package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.share.CaptureResume
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * A capture that fails mid-upload must resume the same note, not create another.
 *
 * WorkManager retries [com.makerocketgonow.unbent.share.UploadWorker] from the top after a
 * dropped radio. These are the facts that retry reads: which note already exists, which
 * files are already on it, and how many attempts the server turned away as unavailable.
 */
class CaptureResumeTest {

    @get:Rule val temp = TemporaryFolder()

    @Test
    fun `a directory with no sidecar has no note yet`() {
        assertNull(CaptureResume.readNoteId(temp.root))
    }

    @Test
    fun `the note id written after create is the one a retry reads`() {
        CaptureResume.writeNoteId(temp.root, "note-abc")
        assertEquals("note-abc", CaptureResume.readNoteId(temp.root))
    }

    @Test
    fun `write creates the directory, so a text-only capture still has somewhere to remember`() {
        val dir = File(temp.root, "shares/job-1")
        CaptureResume.writeNoteId(dir, "note-xyz")
        assertEquals("note-xyz", CaptureResume.readNoteId(dir))
    }

    @Test
    fun `blank sidecar is treated as missing rather than as an id`() {
        File(temp.root, ".note-id").writeText("  \n")
        assertNull(CaptureResume.readNoteId(temp.root))
    }

    @Test
    fun `a capture the server has not turned away has spent no waits`() {
        assertEquals(0, CaptureResume.unavailableAttempts(temp.root))
    }

    @Test
    fun `each 503 is counted once, and a retry reads the total`() {
        val dir = File(temp.root, "shares/job-2")
        assertEquals(1, CaptureResume.recordUnavailable(dir))
        assertEquals(2, CaptureResume.recordUnavailable(dir))
        assertEquals(2, CaptureResume.unavailableAttempts(dir))
        // The note id beside it is a separate fact and survives the count.
        CaptureResume.writeNoteId(dir, "note-1")
        assertEquals(3, CaptureResume.recordUnavailable(dir))
        assertEquals("note-1", CaptureResume.readNoteId(dir))
    }

    @Test
    fun `files already on the note are not uploaded again`() {
        assertEquals(
            listOf("b.jpg"),
            CaptureResume.pendingFilenames(arrayOf("a.pdf", "b.jpg"), listOf("a.pdf")),
        )
    }

    @Test
    fun `a first attempt has everything still to upload`() {
        assertEquals(
            listOf("a.pdf", "b.jpg"),
            CaptureResume.pendingFilenames(arrayOf("a.pdf", "b.jpg"), emptyList()),
        )
    }

    @Test
    fun `a fully landed capture has nothing left`() {
        assertEquals(
            emptyList<String>(),
            CaptureResume.pendingFilenames(arrayOf("a.pdf"), listOf("a.pdf")),
        )
    }
}
