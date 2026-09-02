package app.unbent.android

import app.unbent.android.share.StagedFile
import app.unbent.android.share.Staging
import java.io.File
import java.util.Calendar
import java.util.Date
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Filename and title derivation.
 *
 * These run without a device because the rules they encode come from the server: the API
 * rejects path separators, `.`, `..` and leading dots, and a rejected name silently loses
 * the file the user just shared.
 */
class StagingTest {

    @Test
    fun `keeps an ordinary filename`() {
        assertEquals("receipt.pdf", Staging.sanitize("receipt.pdf", 0, "bin"))
    }

    @Test
    fun `strips a path, keeping only the name`() {
        assertEquals("photo.jpg", Staging.sanitize("/storage/emulated/0/DCIM/photo.jpg", 0, "bin"))
        assertEquals("photo.jpg", Staging.sanitize("C:\\Users\\me\\photo.jpg", 0, "bin"))
    }

    @Test
    fun `strips leading dots, which the API rejects`() {
        assertEquals("hidden.png", Staging.sanitize(".hidden.png", 0, "bin"))
    }

    @Test
    fun `falls back when the name is missing or degenerate`() {
        assertEquals("capture-1.jpg", Staging.sanitize(null, 0, "jpg"))
        assertEquals("capture-2.jpg", Staging.sanitize("", 1, "jpg"))
        assertEquals("capture-3.pdf", Staging.sanitize("..", 2, "pdf"))
        assertEquals("capture-1.jpg", Staging.sanitize(".", 0, "jpg"))
    }

    @Test
    fun `adds an extension when the name has none`() {
        assertEquals("scan.pdf", Staging.sanitize("scan", 0, "pdf"))
    }

    @Test
    fun `removes control characters`() {
        assertEquals("abc.txt", Staging.sanitize("a\u0000b\u001fc.txt", 0, "bin"))
    }

    @Test
    fun `caps an absurdly long name`() {
        val long = "x".repeat(400) + ".pdf"
        assertTrue(Staging.sanitize(long, 0, "bin").length <= 200)
    }

    @Test
    fun `prefers the subject line for the title`() {
        val staged = listOf(staged("photo.jpg"))
        assertEquals("Lab results", Staging.deriveTitle("  Lab results  ", staged))
    }

    @Test
    fun `uses a lone filename stem when there is no subject`() {
        assertEquals("receipt", Staging.deriveTitle(null, listOf(staged("receipt.pdf"))))
    }

    @Test
    fun `falls back to a dated title for a multi-file share`() {
        val when2 = Calendar.getInstance().apply { set(2026, 8, 1, 14, 30, 0) }.time
        val staged = listOf(staged("a.jpg"), staged("b.jpg"))
        assertEquals("Capture 2026-09-01 14:30", Staging.deriveTitle(null, staged, when2))
    }

    @Test
    fun `falls back to a dated title when nothing was shared but text`() {
        val when2 = Date(0)
        assertTrue(Staging.deriveTitle("", emptyList(), when2).startsWith("Capture "))
    }

    private fun staged(name: String) = StagedFile(File("/tmp/$name"), name, "application/octet-stream")
}
